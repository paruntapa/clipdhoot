"""Render a facecam/gameplay vertical stack, following the local GTA clipper's layout logic.

YuNet identifies the persistent webcam overlay; MediaPipe landmarks refine the tracked
face centre. The webcam border is detected across frames and fitted to the top panel.
The gameplay crop is kept beside the webcam and shifted around persistent stream UI.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

OUT_W, OUT_H = 1080, 1920
TOP_H = 768
GAME_H = OUT_H - TOP_H
CAM_AR = OUT_W / TOP_H
GAME_AR = OUT_W / GAME_H
TINY_FACE = 0.022
SAMPLE_COUNT = 40
FACE_SAMPLE_STEP = 4
OVERLAY_BAND = (0.15, 0.10, 0.15, 0.20)
SHARP = 0.6
# Minimum fraction of sampled frames a face must appear in the same grid cell
# to be considered a stable webcam overlay.  Raised from 0.4 to 0.55 so that
# game-character faces (which move across cells) are filtered out.
MIN_CELL_PRESENCE = 0.55
# Maximum standard deviation of face centres (in pixels, at source resolution)
# for a cell to be considered a static webcam overlay.  Game characters move
# around far more than a fixed picture-in-picture overlay.
MAX_CENTER_JITTER = 25.0
# Maximum coefficient of variation (std/mean) of face widths within a cell.
# Webcam overlays keep nearly the same face size; game characters grow and
# shrink as the game camera moves.
MAX_SIZE_CV = 0.35


def face_detector(model: np.ndarray, width: int, height: int, target_width: int = 960):
    return cv2.FaceDetectorYN.create(
        "onnx", model, np.empty(0, np.uint8), (target_width, int(target_width * height / width)), 0.65
    )


def sampled_frames(path: Path, start: float, end: float, count: int = SAMPLE_COUNT):
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError("OpenCV could not open the source video.")
    width, height = int(cap.get(3)), int(cap.get(4))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = max(1, int(round((end - start) * fps)))
    start_frame = max(0, int(round(start * fps)))
    indices = np.unique(np.linspace(0, max(total - 1, 0), count).astype(int))
    frames = []
    for index in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame + int(index))
        ok, frame = cap.read()
        if ok:
            frames.append((int(index), frame))
    cap.release()
    if not frames:
        raise RuntimeError("Could not read frames from the selected clip.")
    return width, height, float(fps), total, start_frame, frames


def refine_with_mediapipe(source: Path, start_frame: int, width: int, height: int, boxes, model_path: Path):
    """Use landmarks inside YuNet face crops so small webcam faces remain detectable."""
    if not model_path.is_file() or len(boxes) < 3:
        return None
    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        return None
    options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=1,
        min_face_detection_confidence=0.3,
        min_face_presence_confidence=0.3,
        min_tracking_confidence=0.3,
        output_face_blendshapes=False,
    )
    refined = []
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        for local_frame, (x, y, w, h) in boxes:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame + local_frame)
            ok, frame = cap.read()
            if not ok:
                continue
            # Keep the crop tight enough that MediaPipe ignores the game behind the cam.
            side = max(96, int(max(w, h) * 2.4))
            cx, cy = x + w / 2, y + h / 2
            x0, y0 = int(round(cx - side / 2)), int(round(cy - side / 2))
            x1, y1 = x0 + side, y0 + side
            left, top = max(0, -x0), max(0, -y0)
            right, bottom = max(0, x1 - width), max(0, y1 - height)
            roi = frame[max(0, y0):min(height, y1), max(0, x0):min(width, x1)]
            if roi.size == 0:
                continue
            if any((left, top, right, bottom)):
                roi = cv2.copyMakeBorder(roi, top, bottom, left, right, cv2.BORDER_REPLICATE)
            roi = cv2.resize(roi, (320, 320), interpolation=cv2.INTER_CUBIC)
            rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
            result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            if not result.face_landmarks:
                continue
            points = result.face_landmarks[0]
            lx = [point.x for point in points]
            ly = [point.y for point in points]
            # Convert landmark bounds from the upscaled square back to source pixels.
            refined.append((
                x0 + (min(lx) + max(lx)) * side / 2,
                y0 + (min(ly) + max(ly)) * side / 2,
                (max(lx) - min(lx)) * side,
                (max(ly) - min(ly)) * side,
            ))
    cap.release()
    return np.median(np.asarray(refined), axis=0) if len(refined) >= max(3, len(boxes) // 3) else None


def find_facecam(source: Path, start: float, end: float, yunet_path: Path, landmark_path: Path):
    width, height, fps, frame_count, start_frame, frames = sampled_frames(source, start, end)
    model = np.frombuffer(yunet_path.read_bytes(), np.uint8)
    detector = face_detector(model, width, height)
    scale = 960 / width
    grid: dict[tuple[int, int], dict[int, tuple[int, tuple[float, float, float, float]]]] = {}
    for sample_id, (local_frame, frame) in enumerate(frames):
        small = cv2.resize(frame, (960, int(960 * height / width)), interpolation=cv2.INTER_AREA)
        _, detections = detector.detect(small)
        if detections is None:
            continue
        for x, y, w, h in detections[:, :4] / scale:
            cell = (min(7, int((x + w / 2) / width * 8)), min(5, int((y + h / 2) / height * 6)))
            grid.setdefault(cell, {})[sample_id] = (local_frame, (float(x), float(y), float(w), float(h)))
    candidates = []
    for cell, hits in grid.items():
        if len(hits) < len(frames) * MIN_CELL_PRESENCE:
            continue
        boxes = np.asarray([value[1] for value in hits.values()])
        centers = boxes[:, :2] + boxes[:, 2:] / 2
        jitter = float(np.std(centers, axis=0).mean())
        face_w = float(np.median(boxes[:, 2]))

        # Relative coordinates of median center
        med_center = np.median(centers, axis=0)
        rel_cx = med_center[0] / width
        rel_cy = med_center[1] / height

        # Size consistency check: webcam overlays keep consistent face size
        w_std = float(np.std(boxes[:, 2]))
        w_mean = float(np.mean(boxes[:, 2]))
        size_cv = w_std / max(1e-5, w_mean)

        max_jitter = min(MAX_CENTER_JITTER, width * 0.035)
        if jitter < 1.0 or jitter > max_jitter:
            continue
        if size_cv > MAX_SIZE_CV:
            continue
        if face_w < width * TINY_FACE or face_w > width * 0.18:
            continue

        # Reject dead-center gameplay zone (where NPC faces and in-game characters appear)
        if (0.28 <= rel_cx <= 0.72) and (0.20 <= rel_cy <= 0.70):
            continue

        # Position bonus: corner overlays are standard for streaming webcams
        is_corner = (rel_cx < 0.30 or rel_cx > 0.70) and (rel_cy < 0.35 or rel_cy > 0.60)
        is_edge = (rel_cx < 0.22 or rel_cx > 0.78 or rel_cy < 0.25 or rel_cy > 0.75)
        if not (is_corner or is_edge):
            continue

        score = (len(hits) / len(frames)) * 50.0
        if is_corner:
            score += 40.0
        elif is_edge:
            score += 20.0

        score -= (jitter / width) * 200.0
        score -= size_cv * 30.0
        candidates.append((score, hits, med_center, face_w))

    if not candidates:
        raise RuntimeError("No stable facecam was found. Choose a clip with a visible streamer webcam or use the blurred layout.")

    candidates.sort(key=lambda item: item[0], reverse=True)

    # Validate with MediaPipe landmark model to confirm genuine human face
    chosen = None
    for score, hits, center, face_w in candidates:
        observations = [(value[0], value[1]) for value in hits.values()]
        landmark = refine_with_mediapipe(source, start_frame, width, height, observations, landmark_path)
        if landmark is not None:
            center = landmark[:2]
            face_w = float(max(face_w, landmark[2]))
            chosen = (hits, center, face_w)
            break
        elif not landmark_path.is_file():
            chosen = (hits, center, face_w)
            break

    if chosen is None:
        raise RuntimeError("Detected face candidate could not be confirmed as a stable streamer webcam. Using the blurred layout.")

    hits, center, face_w = chosen
    if face_w < width * TINY_FACE:
        raise RuntimeError("The webcam face is too small to frame cleanly. Use the blurred layout for this clip.")

    cam = cam_box(float(center[0]), float(center[1]), face_w, width, height)
    cam_edges = camera_edges(source, start, end, cam, width, height)
    cam = fit_camera(cam, cam_edges, width, height)
    return cam, (width, height, fps, frame_count, start_frame)


def cam_box(face_x: float, face_y: float, face_w: float, width: int, height: int, factor: float = 4.2):
    box_w = min(width, face_w * factor)
    box_h = min(height, box_w * TOP_H / OUT_W)
    box_w = box_h * OUT_W / TOP_H
    x0 = np.clip(face_x - box_w / 2, 0, width - box_w)
    y0 = np.clip(face_y - box_h * 0.45, 0, height - box_h)
    return int(x0), int(y0), int(x0 + box_w), int(y0 + box_h)


def camera_edges(source: Path, start: float, end: float, cam, width: int, height: int, count: int = 12):
    cap = cv2.VideoCapture(str(source))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    first = max(0, int(round(start * fps)))
    frames = []
    for local in np.linspace(0, max(int((end - start) * fps) - 2, 0), count).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, first + int(local))
        ok, frame = cap.read()
        if ok:
            frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32))
    cap.release()
    if len(frames) < 4:
        return [None] * 4
    stack = np.asarray(frames)
    gx = np.median(np.abs(stack[:, :, 4:] - stack[:, :, :-4]), axis=0)
    gy = np.median(np.abs(stack[:, 4:] - stack[:, :-4]), axis=0)
    x0, y0, x1, y1 = cam
    cx, cy, w, h = (x0 + x1) // 2, (y0 + y1) // 2, x1 - x0, y1 - y0

    def edge(profile, low, high):
        low, high = max(low, 0), min(high, len(profile))
        if high - low < 5:
            return None
        segment = profile[low:high]
        i = int(np.argmax(segment))
        return low + i + 2 if segment[i] > max(4 * np.median(segment), 6) else None

    px = gx[max(cy - h // 4, 0):min(cy + h // 4, height)].mean(0)
    py = gy[:, max(cx - w // 4, 0):min(cx + w // 4, width)].mean(1)
    return [edge(px, cx - w, cx - w // 5), edge(py, cy - h, cy - h // 5),
            edge(px, cx + w // 5, cx + w), edge(py, cy + h // 5, cy + h)]


def fit_camera(box, edges, width: int, height: int):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    left = edges[0] if edges[0] is not None else (0 if x0 < 0.15 * w else x0)
    top = edges[1] if edges[1] is not None else (0 if y0 < 0.15 * h else y0)
    right = edges[2] if edges[2] is not None else (width if width - x1 < 0.15 * w else x1)
    bottom = edges[3] if edges[3] is not None else (height if height - y1 < 0.15 * h else y1)
    if right - left < 0.5 * w or bottom - top < 0.5 * h:
        return box
    aspect = OUT_W / TOP_H
    crop_w = min(right - left, (bottom - top) * aspect)
    crop_h = crop_w / aspect
    nx = int(np.clip((x0 + x1) / 2 - crop_w / 2, left, right - crop_w))
    ny = int(np.clip(y0 + h * 0.45 - crop_h * 0.45, top, bottom - crop_h))
    return nx, ny, int(nx + crop_w), int(ny + crop_h)


def overlay_boxes(frames):
    if len(frames) < 8:
        return []
    edges = []
    for frame in frames:
        gray = cv2.cvtColor(cv2.resize(frame, (960, 960 * frame.shape[0] // frame.shape[1]), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        edges.append((cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1)) > 100).astype(np.uint8))
    h, w = edges[0].shape
    kernel = np.ones((3, 3), np.uint8)
    pairs = [edges[i + 1] & cv2.dilate(edges[i], kernel) for i in range(len(edges) - 1)]
    keep = ((np.mean(pairs, axis=0) >= 0.5) | (np.max([np.mean(part, axis=0) for part in np.array_split(pairs, 3)], axis=0) >= 0.8)).astype(np.uint8)
    keep &= 1 - cv2.dilate(cv2.morphologyEx(keep, cv2.MORPH_OPEN, np.ones((1, 151), np.uint8)), kernel)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(cv2.morphologyEx(keep, cv2.MORPH_CLOSE, np.ones((5, 25), np.uint8)))
    found = []
    for index, (x, y, bw, bh, area) in enumerate(stats[1:n], 1):
        cx, cy = (x + bw / 2) / w, (y + bh / 2) / h
        if (0.0035 * w * h < area < 0.06 * w * h
                and (keep[y:y + bh, x:x + bw].mean() >= 0.2 or keep[labels == index].mean() >= 0.5)
                and (cx < OVERLAY_BAND[0] or cy < OVERLAY_BAND[1] or cx > 1 - OVERLAY_BAND[2] or cy > 1 - OVERLAY_BAND[3])):
            found.append((x / w, y / h, (x + bw) / w, (y + bh) / h))
    return found


def fit_game_crop(boxes, window, width, height, xlim=None, ylim=None):
    x0, y0, w, h = window
    xlim = xlim or (0, width)
    ylim = ylim or (0, height)
    pad = 0.005 * width
    bounds = np.asarray([(a * width - pad, b * height - pad, c * width + pad, d * height + pad) for a, b, c, d in boxes]).reshape(-1, 4)
    best = (1e9, window)
    for scale in np.linspace(1, 0.78, 8):
        crop_w, crop_h = w * scale, h * scale
        xs, ys = np.meshgrid(
            np.arange(x0 - 8 * ((x0 - xlim[0]) // 8), max(xlim[1] - crop_w, xlim[0]) + 1, 8),
            np.arange(y0 - 8 * ((y0 - ylim[0]) // 8), max(ylim[1] - crop_h, ylim[0]) + 1, 8),
        )
        cost = 1.0 * (1 - scale) + 0.3 * (abs(xs - x0) / width + abs(ys - y0) / height)
        for a, b, c, d in bounds:
            ix = np.clip(np.minimum(xs + crop_w, c) - np.maximum(xs, a), 0, None)
            iy = np.clip(np.minimum(ys + crop_h, d) - np.maximum(ys, b), 0, None)
            cost += (ix * iy > 0) * (0.3 + 0.2 * ix * iy / ((c - a) * (d - b)))
        i = np.unravel_index(cost.argmin(), cost.shape)
        if cost[i] < best[0]:
            best = (cost[i], (int(xs[i]), int(ys[i]), int(crop_w), int(crop_h)))
    return best[1]


def sample_stack_modes(source: Path, start_frame: int, frame_count: int, fps: float, width: int, height: int, cam):
    model_bytes = np.frombuffer((Path(__file__).resolve().parents[1] / "assets" / "yunet.onnx").read_bytes(), np.uint8)
    detector = face_detector(model_bytes, width, height, 640)
    scale = 640 / width
    cap = cv2.VideoCapture(str(source))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    labels, big_x, thumbs = [], [], []
    steps = list(range(0, frame_count, FACE_SAMPLE_STEP))
    for step in steps:
        if step:
            for _ in range(FACE_SAMPLE_STEP - 1):
                cap.grab()
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (640, int(640 * height / width)), interpolation=cv2.INTER_AREA)
        _, detections = detector.detect(small)
        boxes = np.zeros((0, 4)) if detections is None else detections[:, :4] / scale
        in_cam = any(cam[0] <= x + w / 2 <= cam[2] and cam[1] <= y + h / 2 <= cam[3] for x, y, w, h in boxes)
        giant_faces = [x + w / 2 for x, y, w, h in boxes if w >= width * 0.35 and not (cam[0] <= x + w / 2 <= cam[2])]
        if in_cam:
            labels.append(0)
            big_x.append(None)
        elif giant_faces:
            labels.append(1)
            big_x.append(float(np.median(giant_faces)))
        else:
            labels.append(0)
            big_x.append(None)
        thumb = cv2.cvtColor(frame[cam[1]:cam[3], cam[0]:cam[2]], cv2.COLOR_BGR2GRAY)
        thumbs.append(cv2.resize(thumb, (32, 32)).astype(np.float32).ravel())
    cap.release()
    if not labels:
        return [None] * frame_count
    camera_samples = [i for i, label in enumerate(labels) if label == 0]
    if len(camera_samples) >= 5:
        reference = np.median(np.asarray([thumbs[i] for i in camera_samples]), axis=0)
        for i in camera_samples:
            if np.corrcoef(thumbs[i], reference)[0, 1] < 0.4:
                labels[i] = 2
    window = max(5, int(fps / FACE_SAMPLE_STEP) | 1)
    padded = np.pad(np.asarray(labels), window // 2, mode="edge")
    smoothed = np.asarray([np.bincount(padded[i:i + window], minlength=3).argmax() for i in range(len(labels))])
    modes = [None] * frame_count
    for i, label in enumerate(smoothed):
        end = min((i + 1) * FACE_SAMPLE_STEP, frame_count)
        mode = None if label == 0 else "full" if label == 1 else "fill"
        value = float(np.median([x for x in big_x[i:min(i + 1, len(big_x))] if x is not None])) if label == 1 and big_x[i] is not None else (width / 2 if label == 1 else None)
        for frame_index in range(i * FACE_SAMPLE_STEP, end):
            modes[frame_index] = value if mode == "full" else mode
    if len(modes) < frame_count:
        modes.extend(["fill"] * (frame_count - len(modes)))
    return modes


def crop_to_portrait(frame, center_x: float):
    height, width = frame.shape[:2]
    crop_w = min(width, int(height * 9 / 16))
    x0 = int(np.clip(round(center_x - crop_w / 2), 0, width - crop_w))
    return cv2.resize(frame[:, x0:x0 + crop_w], (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)


def blurred_fill(frame):
    height, width = frame.shape[:2]
    small = cv2.resize(frame, (OUT_W // 8, OUT_H // 8), interpolation=cv2.INTER_AREA)
    background = cv2.GaussianBlur(small, (0, 0), 4)
    background = cv2.convertScaleAbs(cv2.resize(background, (OUT_W, OUT_H)), alpha=0.55)
    fitted_h = min(OUT_H, int(OUT_W * height / width))
    fitted_w = min(OUT_W, int(OUT_H * width / height))
    foreground = cv2.resize(frame, (fitted_w, fitted_h), interpolation=cv2.INTER_AREA)
    x0, y0 = (OUT_W - fitted_w) // 2, (OUT_H - fitted_h) // 2
    background[y0:y0 + fitted_h, x0:x0 + fitted_w] = foreground
    return background


def smooth_facesource_crop(frame, cam):
    x0, y0, x1, y1 = cam
    top = cv2.resize(frame[y0:y1, x0:x1], (OUT_W, TOP_H), interpolation=cv2.INTER_LINEAR)
    if OUT_W / max(1, x1 - x0) >= 3:
        top = cv2.addWeighted(top, 1 + SHARP, cv2.GaussianBlur(top, (0, 0), 1.4), -SHARP, 0)
    return top


def render(source: Path, start: float, end: float, output: Path, landmark_path: Path):
    yunet_path = Path(__file__).resolve().parents[1] / "assets" / "yunet.onnx"
    if not yunet_path.is_file():
        raise RuntimeError(f"YuNet face detector is missing: {yunet_path}")
    duration = end - start
    if start < 0 or duration < 1:
        raise RuntimeError("Clip start and end times are invalid.")
    cam, (width, height, fps, frame_count, start_frame) = find_facecam(source, start, end, yunet_path, landmark_path)
    modes = sample_stack_modes(source, start_frame, frame_count, fps, width, height, cam)

    # Replicate render_stack's camera-adjacent crop, then move/shrink it around persistent UI.
    bh = GAME_H
    gy0, gy1 = int(height * 0.03), int(height * 0.96)
    game_w = int((gy1 - gy0) * OUT_W / bh)
    margin = int(0.2 * (cam[2] - cam[0]))
    camera_left = (cam[0] + cam[2]) / 2 < width / 2
    game_x = min(cam[2] + margin, width - game_w) if camera_left else max(cam[0] - margin - game_w, 0)
    game_x = int(np.clip(game_x, 0, max(0, width - game_w)))
    cap = cv2.VideoCapture(str(source))
    frame_ids = [i for i, mode in enumerate(modes) if mode is None]
    clutter_frames = []
    for local_frame in np.asarray(frame_ids)[np.linspace(0, len(frame_ids) - 1, min(24, len(frame_ids))).astype(int)] if frame_ids else []:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame + int(local_frame))
        ok, frame = cap.read()
        if ok:
            clutter_frames.append(frame)
    boxes = overlay_boxes(clutter_frames)
    region = (game_x, gy0, game_w, gy1 - gy0)
    game_x, gy0, game_w, game_h = fit_game_crop(boxes, region, width, height,
                                                  (game_x, width) if camera_left else (0, game_x + game_w), (0, height))

    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-y", "-loglevel", "error", "-threads", "0", "-f", "rawvideo", "-pix_fmt", "yuv420p",
        "-s", f"{OUT_W}x{OUT_H}", "-r", f"{fps:.6f}", "-i", "-", "-an", "-c:v", "libx264",
        "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ]
    encoder = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for index in range(frame_count):
            ok, frame = cap.read()
            if not ok:
                break
            mode = modes[index]
            if mode == "fill":
                canvas = blurred_fill(frame)
            elif mode is not None:
                canvas = crop_to_portrait(frame, float(mode))
            else:
                canvas = np.empty((OUT_H, OUT_W, 3), dtype=np.uint8)
                canvas[:TOP_H] = smooth_facesource_crop(frame, cam)
                game = cv2.resize(frame[gy0:gy0 + game_h, game_x:game_x + game_w], (OUT_W, GAME_H), interpolation=cv2.INTER_LINEAR)
                canvas[TOP_H:] = game
                canvas[TOP_H - 3:TOP_H + 3] = 0
            encoder.stdin.write(cv2.cvtColor(canvas, cv2.COLOR_BGR2YUV_I420).tobytes())
    except BaseException:
        encoder.kill()
        raise
    finally:
        cap.release()
        if encoder.stdin and not encoder.stdin.closed:
            encoder.stdin.close()
    stderr = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
    if encoder.wait():
        output.unlink(missing_ok=True)
        raise RuntimeError(f"FFmpeg could not render the stacked clip: {stderr[-1000:]}")
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("FFmpeg produced an empty stacked clip.")


def probe_layout(source: Path, start: float, end: float, landmark_path: Path):
    yunet_path = Path(__file__).resolve().parents[1] / "assets" / "yunet.onnx"
    if not yunet_path.is_file():
        return {"hasCam": False, "error": "YuNet model file is missing"}

    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        return {"hasCam": False, "error": "Could not open source video"}

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    def read_forward_frames(from_sec: float, n_frames: int = 10):
        start_f = max(0, int(from_sec * fps))
        if start_f >= total_frames and total_frames > 0:
            start_f = 0
        cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
        frs = []
        step = max(1, int(fps * 0.3))
        for _ in range(n_frames):
            ok, fr = cap.read()
            if not ok:
                break
            frs.append(fr)
            for _ in range(step - 1):
                if not cap.grab():
                    break
        return frs

    frames = read_forward_frames(start, 10)
    if not frames and start > 0:
        frames = read_forward_frames(0, 10)
    cap.release()

    if not frames:
        return {"hasCam": False, "error": "Could not read frames from clip"}

    model = np.frombuffer(yunet_path.read_bytes(), np.uint8)
    detector = cv2.FaceDetectorYN.create("onnx", model, np.empty(0, np.uint8), (960, int(960 * height / width)), 0.60)
    scale = 960 / width

    def find_candidates(fr_list):
        grid = {}
        for sample_id, fr in enumerate(fr_list):
            small = cv2.resize(fr, (960, int(960 * height / width)), interpolation=cv2.INTER_AREA)
            _, detections = detector.detect(small)
            if detections is None:
                continue
            for x, y, w, h in detections[:, :4] / scale:
                cell = (min(7, int((x + w / 2) / width * 8)), min(5, int((y + h / 2) / height * 6)))
                grid.setdefault(cell, []).append((sample_id, float(x), float(y), float(w), float(h)))
        cands = []
        for cell, hits in grid.items():
            if len(hits) < max(2, int(len(fr_list) * 0.30)):
                continue
            boxes = np.asarray([h[1:] for h in hits])
            centers = boxes[:, :2] + boxes[:, 2:] / 2
            jitter = float(np.std(centers, axis=0).mean()) if len(hits) > 1 else 0.0
            face_w = float(np.median(boxes[:, 2]))
            med_center = np.median(centers, axis=0)
            rel_cx = med_center[0] / width
            rel_cy = med_center[1] / height

            # Reject dead-center gameplay zone (where NPC faces and in-game characters appear)
            if (0.28 <= rel_cx <= 0.72) and (0.20 <= rel_cy <= 0.70):
                continue
            if face_w < width * TINY_FACE or face_w > width * 0.25:
                continue

            is_corner = (rel_cx < 0.32 or rel_cx > 0.68) and (rel_cy < 0.35 or rel_cy > 0.65)
            is_edge = (rel_cx < 0.25 or rel_cx > 0.75 or rel_cy < 0.25 or rel_cy > 0.75)
            score = len(hits) * 10.0
            if is_corner:
                score += 50.0
            elif is_edge:
                score += 25.0
            score -= jitter * 5.0
            cands.append((score, med_center, face_w, hits))
        cands.sort(key=lambda x: x[0], reverse=True)
        return cands

    cands = find_candidates(frames)
    if not cands and end > start + 3:
        cap_retry = cv2.VideoCapture(str(source))
        mid = (start + end) / 2
        cap_retry.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(mid * fps)))
        mid_frames = []
        step = max(1, int(fps * 0.3))
        for _ in range(8):
            ok, fr = cap_retry.read()
            if not ok:
                break
            mid_frames.append(fr)
            for _ in range(step - 1):
                if not cap_retry.grab():
                    break
        cap_retry.release()
        if mid_frames:
            retry_cands = find_candidates(mid_frames)
            if retry_cands:
                cands = retry_cands
                frames = mid_frames

    if not cands:
        return {"hasCam": False, "error": "No stable webcam face detected"}

    best = cands[0]
    cx, cy = best[1]
    face_w = best[2]
    hits = best[3]

    if landmark_path and landmark_path.is_file():
        try:
            options = vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=str(landmark_path)),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.3,
            )
            with vision.FaceLandmarker.create_from_options(options) as landmarker:
                for sid, x, y, w, h in hits[:2]:
                    if sid < len(frames):
                        pad = int(w * 0.4)
                        x0 = max(0, int(x - pad))
                        y0 = max(0, int(y - pad))
                        x1 = min(width, int(x + w + pad))
                        y1 = min(height, int(y + h + pad))
                        roi = frames[sid][y0:y1, x0:x1]
                        if roi.size > 0:
                            rgb = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB)
                            res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
                            if res.face_landmarks:
                                pts = res.face_landmarks[0]
                                lx = [p.x * (x1 - x0) + x0 for p in pts]
                                ly = [p.y * (y1 - y0) + y0 for p in pts]
                                cx = float((min(lx) + max(lx)) / 2)
                                cy = float((min(ly) + max(ly)) / 2)
                                face_w = float(max(face_w, max(lx) - min(lx)))
                                break
        except Exception:
            pass

    cam = cam_box(cx, cy, face_w, width, height)
    bh = GAME_H
    gy0, gy1 = int(height * 0.03), int(height * 0.96)
    game_w = int((gy1 - gy0) * OUT_W / bh)
    margin = int(0.2 * (cam[2] - cam[0]))
    camera_left = (cam[0] + cam[2]) / 2 < width / 2
    game_x = min(cam[2] + margin, width - game_w) if camera_left else max(cam[0] - margin - game_w, 0)
    game_x = int(np.clip(game_x, 0, max(0, width - game_w)))
    game_h = gy1 - gy0

    return {
        "hasCam": True,
        "cam": [int(cam[0]), int(cam[1]), int(cam[2]), int(cam[3])],
        "game": [int(game_x), int(gy0), int(game_x + game_w), int(gy0 + game_h)],
        "width": int(width),
        "height": int(height),
    }


def main():
    if len(sys.argv) == 6 and sys.argv[1] == "probe":
        _, _, source, start, end, model = sys.argv
        res = probe_layout(Path(source), float(start), float(end), Path(model))
        print(json.dumps(res))
        return
    if len(sys.argv) != 6:
        raise SystemExit("Usage: facecam_stack.py SOURCE START END OUTPUT FACE_LANDMARKER_MODEL")
    source, start, end, output, model = sys.argv[1:]
    try:
        render(Path(source), float(start), float(end), Path(output), Path(model))
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
