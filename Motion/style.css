// ── DOM references ──────────────────────────────────────────────────────────
const videoElement            = document.getElementById('camera-feed');
const cameraCanvas            = document.getElementById('camera-canvas');
const overlayCanvas           = document.getElementById('overlay-canvas');
const statusBadge             = document.getElementById('status-badge');
const hudPanel                = document.getElementById('hud');

const startStopBtn            = document.getElementById('start-stop-btn');
const toggleHudBtn            = document.getElementById('toggle-hud-btn');
const resetPeakBtn            = document.getElementById('reset-peak-btn');
const snapshotBtn             = document.getElementById('snapshot-btn');
const clearLogBtn             = document.getElementById('clear-log-btn');
const clearZoneBtn            = document.getElementById('clear-zone-btn');
const autoRecordToggle        = document.getElementById('auto-record-toggle');
const recordingStatusRow      = document.getElementById('recording-status-row');

const motionPercentDisplay    = document.getElementById('motion-percent');
const peakPercentDisplay      = document.getElementById('peak-percent');
const fpsDisplay              = document.getElementById('fps-display');
const meterFill               = document.getElementById('meter-fill');
const historyGraphCanvas      = document.getElementById('history-graph');
const eventLogList            = document.getElementById('event-log');

const sensitivitySlider       = document.getElementById('sensitivity-slider');
const sensitivityValueLabel   = document.getElementById('sensitivity-value');
const noiseReductionSlider    = document.getElementById('noise-reduction-slider');
const noiseReductionValueLabel= document.getElementById('noise-reduction-value');
const overlayOpacitySlider    = document.getElementById('overlay-opacity-slider');
const overlayOpacityValueLabel= document.getElementById('overlay-opacity-value');
const overlayModeSelect       = document.getElementById('overlay-mode-select');
const overlayColorRow         = document.getElementById('overlay-color-row');
const overlayColorSelect      = document.getElementById('overlay-color-select');
const showOverlayToggle       = document.getElementById('show-overlay-toggle');
const mirrorToggle            = document.getElementById('mirror-toggle');
const grayscaleToggle         = document.getElementById('grayscale-toggle');
const alertToggle             = document.getElementById('alert-toggle');
const alertThresholdSection   = document.getElementById('alert-threshold-section');
const alertThresholdSlider    = document.getElementById('alert-threshold-slider');
const alertThresholdValueLabel= document.getElementById('alert-threshold-value');

const viewportDiv             = document.getElementById('viewport');

// ── Constants ────────────────────────────────────────────────────────────────
const HISTORY_MAX_SAMPLES     = 300;  // ~60 s at ~5 samples/s
const EVENT_LOG_MAX_ENTRIES   = 20;
// Minimum ms between consecutive log entries to avoid flooding
const EVENT_LOG_COOLDOWN_MS   = 2000;

// ── Runtime state ───────────────────────────────────────────────────────────
const state = {
  isRunning:             false,
  cameraStream:          null,
  animationFrameId:      null,
  previousFrameData:     null,
  peakMotionPercent:     0,
  smoothedMotionPercent: 0,
  fpsFrameCount:         0,
  fpsLastTimestamp:      0,

  // Sparkline history (rolling buffer of smoothed motion %)
  motionHistory:         [],

  // Used to detect rising edge for event log
  wasAboveAlertThreshold:  false,
  lastEventLogTimestampMs: 0,

  // Region of Interest: null = full frame, or { x, y, width, height } in canvas pixels
  roi:              null,
  isDrawingRoi:     false,
  roiDragStart:     null,   // { x, y } canvas pixels at drag start
  currentDragRoi:   null,   // live { x, y, width, height } while dragging

  // Auto-record
  isRecording:            false,
  mediaRecorder:          null,
  recordedChunks:         [],
  recordingCanvas:        null,
  recordingContext:       null,
  recordingStopTimeoutId: null,
};

// Size the history canvas to its CSS display size
function initHistoryGraph() {
  const rect = historyGraphCanvas.getBoundingClientRect();
  historyGraphCanvas.width  = rect.width  || 240;
  historyGraphCanvas.height = rect.height || 48;
}
initHistoryGraph();

// Offscreen canvas used only for pixel-reading (never added to DOM)
const processingCanvas  = document.createElement('canvas');
const processingContext = processingCanvas.getContext('2d', { willReadFrequently: true });

// ── Heatmap LUT ──────────────────────────────────────────────────────────────
// Precompute RGB values for all 256 possible diff intensities.
// The ramp goes: black → blue → cyan → yellow → red (classic thermal palette).
function buildHeatmapLookupTable() {
  const table = new Uint8Array(256 * 3);
  for (let intensity = 0; intensity < 256; intensity++) {
    const normalized = intensity / 255;
    let red, green, blue;
    if (normalized < 0.25) {
      // Black → Blue
      red = 0; green = 0; blue = Math.round(normalized * 4 * 255);
    } else if (normalized < 0.5) {
      // Blue → Cyan
      const transitionProgress = (normalized - 0.25) * 4;
      red = 0; green = Math.round(transitionProgress * 255); blue = 255;
    } else if (normalized < 0.75) {
      // Cyan → Yellow
      const transitionProgress = (normalized - 0.5) * 4;
      red = Math.round(transitionProgress * 255);
      green = 255;
      blue  = Math.round((1 - transitionProgress) * 255);
    } else {
      // Yellow → Red
      const transitionProgress = (normalized - 0.75) * 4;
      red = 255; green = Math.round((1 - transitionProgress) * 255); blue = 0;
    }
    table[intensity * 3]     = red;
    table[intensity * 3 + 1] = green;
    table[intensity * 3 + 2] = blue;
  }
  return table;
}

const HEATMAP_LUT = buildHeatmapLookupTable();

// ── Read current control values into a plain settings object ─────────────────
function readSettings() {
  return {
    sensitivityThreshold:   parseInt(sensitivitySlider.value, 10),
    noiseReductionBlurPx:   parseInt(noiseReductionSlider.value, 10),
    overlayOpacity:         parseInt(overlayOpacitySlider.value, 10) / 100,
    overlayMode:            overlayModeSelect.value,          // 'highlight' | 'heatmap'
    overlayColorRgb:        overlayColorSelect.value,
    showOverlay:            showOverlayToggle.checked,
    mirrorCamera:           mirrorToggle.checked,
    grayscaleMode:          grayscaleToggle.checked,
    alertEnabled:           alertToggle.checked,
    autoRecordEnabled:      autoRecordToggle.checked,
    alertThresholdPercent:  parseInt(alertThresholdSlider.value, 10),
  };
}

// ── Camera start / stop ─────────────────────────────────────────────────────
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    videoElement.srcObject = stream;
    state.cameraStream = stream;

    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => { videoElement.play(); resolve(); };
    });

    resizeCanvasesToVideo();

    // Build the off-screen composite canvas used by MediaRecorder
    state.recordingCanvas         = document.createElement('canvas');
    state.recordingCanvas.width   = videoElement.videoWidth;
    state.recordingCanvas.height  = videoElement.videoHeight;
    state.recordingContext        = state.recordingCanvas.getContext('2d');

    state.previousFrameData        = null;
    state.isRunning                = true;
    state.fpsFrameCount            = 0;
    state.fpsLastTimestamp         = 0;
    state.smoothedMotionPercent    = 0;
    state.motionHistory            = [];
    state.wasAboveAlertThreshold   = false;
    state.lastEventLogTimestampMs  = 0;
    state.roi                      = null;
    state.isDrawingRoi             = false;
    state.roiDragStart             = null;
    state.currentDragRoi           = null;
    state.isRecording              = false;
    state.recordedChunks           = [];
    state.recordingStopTimeoutId   = null;

    startStopBtn.textContent = 'Stop Camera';
    startStopBtn.classList.add('running');
    viewportDiv.classList.add('camera-active');
    clearZoneBtn.disabled = true;
    setStatusBadge('active');
    scheduleNextFrame();

  } catch (error) {
    console.error('Camera access failed:', error);
    setStatusBadge('inactive');
    alert('Could not access camera — please allow camera permissions and try again.');
  }
}

function stopCamera() {
  // Finalise any in-progress recording before shutting down
  if (state.isRecording) stopRecording();

  if (state.animationFrameId) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = null;
  }

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
  }

  videoElement.srcObject   = null;
  state.isRunning          = false;
  state.previousFrameData  = null;
  state.roi                = null;
  state.isDrawingRoi       = false;
  state.roiDragStart       = null;
  state.currentDragRoi     = null;

  cameraCanvas.getContext('2d').clearRect(0, 0, cameraCanvas.width, cameraCanvas.height);
  overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  startStopBtn.textContent = 'Start Camera';
  startStopBtn.classList.remove('running');
  viewportDiv.classList.remove('camera-active');
  clearZoneBtn.disabled = true;
  setStatusBadge('inactive');
  refreshMotionHud(0);
}

function resizeCanvasesToVideo() {
  const width  = videoElement.videoWidth;
  const height = videoElement.videoHeight;
  cameraCanvas.width  = width;   cameraCanvas.height  = height;
  overlayCanvas.width = width;   overlayCanvas.height = height;
}

// ── rAF loop ────────────────────────────────────────────────────────────────
function scheduleNextFrame() {
  state.animationFrameId = requestAnimationFrame(processFrame);
}

function processFrame(timestamp) {
  if (!state.isRunning) return;

  const videoWidth  = videoElement.videoWidth;
  const videoHeight = videoElement.videoHeight;

  // Guard: video not ready yet
  if (videoWidth === 0 || videoHeight === 0) {
    scheduleNextFrame();
    return;
  }

  // Keep processing canvas in sync with video resolution
  if (processingCanvas.width !== videoWidth || processingCanvas.height !== videoHeight) {
    processingCanvas.width  = videoWidth;
    processingCanvas.height = videoHeight;
    state.previousFrameData = null;
  }

  const settings = readSettings();

  // Apply noise reduction: blurring before getImageData smooths pixel-level noise,
  // preventing false motion detections caused by sensor grain or compression artefacts.
  processingContext.filter = settings.noiseReductionBlurPx > 0
    ? `blur(${settings.noiseReductionBlurPx}px)`
    : 'none';
  processingContext.drawImage(videoElement, 0, 0, videoWidth, videoHeight);
  processingContext.filter = 'none';
  const currentFrameData = processingContext.getImageData(0, 0, videoWidth, videoHeight);

  let motionPercent    = 0;
  let overlayImageData = null;

  if (state.previousFrameData !== null) {
    const diffResult = computeFrameDiff(
      state.previousFrameData,
      currentFrameData,
      settings.sensitivityThreshold,
      settings.overlayColorRgb,
      settings.overlayOpacity,
      state.roi,
      settings.overlayMode   // ← determines highlight vs heatmap colouring
    );
    motionPercent    = diffResult.motionPercent;
    overlayImageData = diffResult.overlayImageData;
  }

  state.previousFrameData = currentFrameData;

  // Draw camera feed (with optional horizontal mirror via CSS transform)
  applyCameraMirror(settings.mirrorCamera);
  drawCameraFrame(videoWidth, videoHeight, settings.grayscaleMode);

  // Draw or clear the motion overlay
  if (settings.showOverlay && overlayImageData !== null) {
    overlayCanvas.getContext('2d').putImageData(overlayImageData, 0, 0);
  } else {
    overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  // Draw ROI zone rect on top of overlay every frame
  drawRoiRect();

  // Feed the composite recording canvas every frame while recording
  if (state.isRecording) compositeFrameToRecordingCanvas(settings);

  // Exponential moving average keeps the meter from flickering
  const smoothingFactor   = 0.25;
  state.smoothedMotionPercent =
    state.smoothedMotionPercent * (1 - smoothingFactor) + motionPercent * smoothingFactor;

  if (state.smoothedMotionPercent > state.peakMotionPercent) {
    state.peakMotionPercent = state.smoothedMotionPercent;
  }

  refreshMotionHud(state.smoothedMotionPercent);
  checkAndLogMotionEvent(state.smoothedMotionPercent, settings, timestamp);
  handleAutoRecord(state.smoothedMotionPercent, settings);
  setStatusBadge(resolveStatusMode(state.smoothedMotionPercent, settings));
  tickFpsCounter(timestamp);

  scheduleNextFrame();
}

// ── Pixel-diff engine ───────────────────────────────────────────────────────
function computeFrameDiff(previousData, currentData, threshold, overlayColorString, overlayOpacity, roi, overlayMode) {
  const totalPixels    = previousData.width * previousData.height;
  const frameWidth     = previousData.width;
  const previousPixels = previousData.data;
  const currentPixels  = currentData.data;

  const overlayImageData = new ImageData(previousData.width, previousData.height);
  const overlayPixels    = overlayImageData.data;

  const [overlayRed, overlayGreen, overlayBlue] = overlayColorString.split(',').map(Number);
  const maxAlpha      = Math.round(overlayOpacity * 255);
  const useHeatmap    = overlayMode === 'heatmap';

  let motionPixelCount = 0;

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex++) {
    // When an ROI is active, skip pixels that fall outside it
    if (roi !== null) {
      const pixelRow = Math.floor(pixelIndex / frameWidth);
      const pixelCol = pixelIndex % frameWidth;
      const outsideHorizontally = pixelCol < roi.x || pixelCol >= roi.x + roi.width;
      const outsideVertically   = pixelRow < roi.y || pixelRow >= roi.y + roi.height;
      if (outsideHorizontally || outsideVertically) continue;
    }

    const offset = pixelIndex * 4;

    const redDiff   = Math.abs(currentPixels[offset]     - previousPixels[offset]);
    const greenDiff = Math.abs(currentPixels[offset + 1] - previousPixels[offset + 1]);
    const blueDiff  = Math.abs(currentPixels[offset + 2] - previousPixels[offset + 2]);

    // Use the strongest channel change as the motion signal
    const maxChannelDiff = Math.max(redDiff, greenDiff, blueDiff);

    if (maxChannelDiff > threshold) {
      if (useHeatmap) {
        // Look up the thermal colour for this diff intensity
        const lutIndex = maxChannelDiff * 3;
        overlayPixels[offset]     = HEATMAP_LUT[lutIndex];
        overlayPixels[offset + 1] = HEATMAP_LUT[lutIndex + 1];
        overlayPixels[offset + 2] = HEATMAP_LUT[lutIndex + 2];
      } else {
        overlayPixels[offset]     = overlayRed;
        overlayPixels[offset + 1] = overlayGreen;
        overlayPixels[offset + 2] = overlayBlue;
      }
      // Alpha scales with diff intensity for both modes
      overlayPixels[offset + 3] = Math.min(maxAlpha, Math.round((maxChannelDiff / 255) * maxAlpha * 2));
      motionPixelCount++;
    }
    // Transparent pixels stay at alpha = 0 (default ImageData)
  }

  // Express motion % relative to the ROI area (or full frame when no ROI)
  const comparisonPixelCount = roi !== null
    ? Math.max(1, roi.width * roi.height)
    : totalPixels;

  return {
    motionPercent:  (motionPixelCount / comparisonPixelCount) * 100,
    overlayImageData,
  };
}

// ── Drawing helpers ─────────────────────────────────────────────────────────
function drawCameraFrame(videoWidth, videoHeight, useGrayscale) {
  const cameraCtx = cameraCanvas.getContext('2d');
  // CSS filter is cheap and keeps pixel data intact for diff engine
  cameraCanvas.style.filter = useGrayscale ? 'grayscale(1)' : 'none';
  cameraCtx.drawImage(videoElement, 0, 0, videoWidth, videoHeight);
}

// Mirror both canvases with CSS so overlay stays in sync with camera
function applyCameraMirror(shouldMirror) {
  const transformValue = shouldMirror ? 'scaleX(-1)' : 'scaleX(1)';
  cameraCanvas.style.transform  = transformValue;
  overlayCanvas.style.transform = transformValue;
}

// ── ROI drawing ──────────────────────────────────────────────────────────────
function drawRoiRect() {
  // Use the live drag preview rect while dragging, otherwise the confirmed roi
  const activeRoi = state.isDrawingRoi ? state.currentDragRoi : state.roi;
  if (!activeRoi) return;

  const ctx           = overlayCanvas.getContext('2d');
  const canvasWidth   = overlayCanvas.width;
  const canvasHeight  = overlayCanvas.height;

  ctx.save();

  // Dim the area OUTSIDE the zone so the active region stands out
  ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
  ctx.fillRect(0, 0, canvasWidth, activeRoi.y);                                                         // top strip
  ctx.fillRect(0, activeRoi.y + activeRoi.height, canvasWidth, canvasHeight - activeRoi.y - activeRoi.height); // bottom strip
  ctx.fillRect(0, activeRoi.y, activeRoi.x, activeRoi.height);                                          // left strip
  ctx.fillRect(activeRoi.x + activeRoi.width, activeRoi.y, canvasWidth - activeRoi.x - activeRoi.width, activeRoi.height); // right strip

  // Marching-ants dashed border — lineDashOffset advances with wall-clock time
  const dashOffset = (Date.now() / 60) % 24;
  ctx.strokeStyle   = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth     = 2;
  ctx.setLineDash([10, 6]);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeRect(activeRoi.x, activeRoi.y, activeRoi.width, activeRoi.height);

  // Corner accent squares for a professional crosshair feel
  const cornerSize = 10;
  ctx.fillStyle    = '#ffffff';
  ctx.setLineDash([]);
  const corners = [
    [activeRoi.x,                    activeRoi.y],
    [activeRoi.x + activeRoi.width - cornerSize, activeRoi.y],
    [activeRoi.x,                    activeRoi.y + activeRoi.height - cornerSize],
    [activeRoi.x + activeRoi.width - cornerSize, activeRoi.y + activeRoi.height - cornerSize],
  ];
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx, cy, cornerSize, 2);
    ctx.fillRect(cx, cy, 2, cornerSize);
  }

  ctx.restore();
}

// ── ROI drag input ────────────────────────────────────────────────────────────
// Map a MouseEvent from the viewport div to canvas pixel coordinates,
// accounting for the CSS-stretched canvas display size vs its intrinsic resolution.
function viewportMouseToCanvasPixel(event) {
  const canvasRect = overlayCanvas.getBoundingClientRect();
  const scaleX     = overlayCanvas.width  / canvasRect.width;
  const scaleY     = overlayCanvas.height / canvasRect.height;
  return {
    x: Math.round((event.clientX - canvasRect.left) * scaleX),
    y: Math.round((event.clientY - canvasRect.top)  * scaleY),
  };
}

viewportDiv.addEventListener('mousedown', (event) => {
  if (!state.isRunning) return;
  const startPixel       = viewportMouseToCanvasPixel(event);
  state.isDrawingRoi     = true;
  state.roiDragStart     = startPixel;
  state.currentDragRoi   = { x: startPixel.x, y: startPixel.y, width: 0, height: 0 };
  event.preventDefault(); // prevent text selection while dragging
});

viewportDiv.addEventListener('mousemove', (event) => {
  if (!state.isDrawingRoi || !state.roiDragStart) return;
  const currentPixel   = viewportMouseToCanvasPixel(event);
  const x              = Math.min(state.roiDragStart.x, currentPixel.x);
  const y              = Math.min(state.roiDragStart.y, currentPixel.y);
  const width          = Math.abs(currentPixel.x - state.roiDragStart.x);
  const height         = Math.abs(currentPixel.y - state.roiDragStart.y);
  state.currentDragRoi = { x, y, width, height };
});

viewportDiv.addEventListener('mouseup', () => {
  if (!state.isDrawingRoi) return;
  state.isDrawingRoi = false;

  const drawnRoi = state.currentDragRoi;
  const hasMinimumSize = drawnRoi && drawnRoi.width > 10 && drawnRoi.height > 10;

  if (hasMinimumSize) {
    state.roi             = { ...drawnRoi };
    clearZoneBtn.disabled = false;
  }

  state.roiDragStart   = null;
  state.currentDragRoi = null;
});

// Cancel the drag if the pointer leaves the viewport mid-drag
viewportDiv.addEventListener('mouseleave', () => {
  if (!state.isDrawingRoi) return;
  state.isDrawingRoi   = false;
  state.roiDragStart   = null;
  state.currentDragRoi = null;
});

clearZoneBtn.addEventListener('click', () => {
  state.roi             = null;
  state.isDrawingRoi    = false;
  state.roiDragStart    = null;
  state.currentDragRoi  = null;
  clearZoneBtn.disabled = true;
  // Flush previous frame so the diff restarts clean over the full frame
  state.previousFrameData = null;
});

// ── HUD refresh ─────────────────────────────────────────────────────────────
function refreshMotionHud(motionPercent) {
  const clampedPercent     = Math.min(100, motionPercent);
  const displayPercent     = clampedPercent.toFixed(1);
  const displayPeakPercent = Math.min(100, state.peakMotionPercent).toFixed(1);

  motionPercentDisplay.textContent = `${displayPercent}%`;
  peakPercentDisplay.textContent   = `${displayPeakPercent}%`;

  meterFill.style.width = `${clampedPercent}%`;
  meterFill.classList.toggle('active', clampedPercent > 50);

  // Push a sample to the rolling history buffer (throttled to ~5 samples/s)
  const now = performance.now();
  if (state.motionHistory.length === 0 || now - state._lastHistorySampleMs > 200) {
    state._lastHistorySampleMs = now;
    state.motionHistory.push(clampedPercent);
    if (state.motionHistory.length > HISTORY_MAX_SAMPLES) {
      state.motionHistory.shift();
    }
  }

  drawSparkline();
}

// ── Sparkline renderer ───────────────────────────────────────────────────────
function drawSparkline() {
  const canvas  = historyGraphCanvas;
  const ctx     = canvas.getContext('2d');
  const width   = canvas.width;
  const height  = canvas.height;
  const samples = state.motionHistory;

  ctx.clearRect(0, 0, width, height);

  if (samples.length < 2) return;

  // Shaded area under the line
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0,   'rgba(59,130,246,0.45)');
  gradient.addColorStop(1,   'rgba(59,130,246,0.03)');

  const stepX = width / (HISTORY_MAX_SAMPLES - 1);

  // Offset so newest sample is always at the right edge
  const startIndex = Math.max(0, HISTORY_MAX_SAMPLES - samples.length);

  ctx.beginPath();
  ctx.moveTo(startIndex * stepX, height);

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const xPosition = (startIndex + sampleIndex) * stepX;
    const yPosition = height - (samples[sampleIndex] / 100) * height;
    ctx.lineTo(xPosition, yPosition);
  }

  ctx.lineTo((startIndex + samples.length - 1) * stepX, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Stroke line on top
  ctx.beginPath();
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const xPosition = (startIndex + sampleIndex) * stepX;
    const yPosition = height - (samples[sampleIndex] / 100) * height;
    if (sampleIndex === 0) ctx.moveTo(xPosition, yPosition);
    else                   ctx.lineTo(xPosition, yPosition);
  }
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

// ── Motion event log ─────────────────────────────────────────────────────────
function checkAndLogMotionEvent(motionPercent, settings, timestamp) {
  if (!settings.alertEnabled) {
    state.wasAboveAlertThreshold = false;
    return;
  }

  const isAboveThreshold = motionPercent >= settings.alertThresholdPercent;
  const nowMs            = Date.now();
  const cooldownElapsed  = (nowMs - state.lastEventLogTimestampMs) >= EVENT_LOG_COOLDOWN_MS;

  // Log only on the rising edge (transition from below to above) with cooldown
  if (isAboveThreshold && !state.wasAboveAlertThreshold && cooldownElapsed) {
    appendEventLogEntry(motionPercent);
    state.lastEventLogTimestampMs = nowMs;
  }

  state.wasAboveAlertThreshold = isAboveThreshold;
}

function appendEventLogEntry(motionPercent) {
  // Remove the "no events" placeholder if present
  const placeholder = eventLogList.querySelector('.event-log__empty');
  if (placeholder) placeholder.remove();

  const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const listItem = document.createElement('li');
  listItem.className = 'event-log__entry';
  listItem.innerHTML =
    `<span class="event-log__time">${timeLabel}</span>` +
    `<span class="event-log__value">${motionPercent.toFixed(1)}%</span>`;

  // Newest at the top
  eventLogList.insertBefore(listItem, eventLogList.firstChild);

  // Trim to max
  while (eventLogList.children.length > EVENT_LOG_MAX_ENTRIES) {
    eventLogList.removeChild(eventLogList.lastChild);
  }
}

function clearEventLog() {
  eventLogList.innerHTML = '<li class="event-log__empty">No events yet</li>';
  state.wasAboveAlertThreshold  = false;
  state.lastEventLogTimestampMs = 0;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────
function takeSnapshot() {
  if (!state.isRunning) {
    alert('Start the camera first to take a snapshot.');
    return;
  }

  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width  = cameraCanvas.width;
  compositeCanvas.height = cameraCanvas.height;
  const compositeCtx = compositeCanvas.getContext('2d');

  // Respect mirror state by flipping the composite canvas
  const settings = readSettings();
  if (settings.mirrorCamera) {
    compositeCtx.translate(compositeCanvas.width, 0);
    compositeCtx.scale(-1, 1);
  }

  // Apply grayscale if active
  if (settings.grayscaleMode) {
    compositeCtx.filter = 'grayscale(1)';
  }

  compositeCtx.drawImage(cameraCanvas, 0, 0);
  compositeCtx.filter = 'none';
  compositeCtx.setTransform(1, 0, 0, 1, 0, 0); // reset transform before overlay
  compositeCtx.drawImage(overlayCanvas, 0, 0);

  const downloadAnchor      = document.createElement('a');
  const isoTimestamp        = new Date().toISOString().replace(/[:.]/g, '-');
  downloadAnchor.download   = `motion-snapshot-${isoTimestamp}.png`;
  downloadAnchor.href       = compositeCanvas.toDataURL('image/png');
  downloadAnchor.click();
}

function setStatusBadge(mode) {
  statusBadge.className = 'badge';
  if (mode === 'inactive') {
    statusBadge.classList.add('badge--inactive');
    statusBadge.textContent = '● INACTIVE';
  } else if (mode === 'alert') {
    statusBadge.classList.add('badge--alert');
    statusBadge.textContent = '⚠ MOTION ALERT';
  } else {
    statusBadge.classList.add('badge--active');
    statusBadge.textContent = '● LIVE';
  }
}

function resolveStatusMode(motionPercent, settings) {
  if (!state.isRunning) return 'inactive';
  if (settings.alertEnabled && motionPercent >= settings.alertThresholdPercent) return 'alert';
  return 'active';
}

function tickFpsCounter(timestamp) {
  state.fpsFrameCount++;

  if (state.fpsLastTimestamp === 0) {
    state.fpsLastTimestamp = timestamp;
    return;
  }

  const elapsedSeconds = (timestamp - state.fpsLastTimestamp) / 1000;

  if (elapsedSeconds >= 1.0) {
    const fps = Math.round(state.fpsFrameCount / elapsedSeconds);
    fpsDisplay.textContent  = `${fps}`;
    state.fpsFrameCount     = 0;
    state.fpsLastTimestamp  = timestamp;
  }
}

// ── Auto-record ──────────────────────────────────────────────────────────────
// Composite video + overlay into the off-screen recording canvas every frame.
// The MediaRecorder stream reads from this canvas.
function compositeFrameToRecordingCanvas(settings) {
  const recCtx    = state.recordingContext;
  const recCanvas = state.recordingCanvas;
  if (!recCtx || !recCanvas) return;

  recCtx.clearRect(0, 0, recCanvas.width, recCanvas.height);

  if (settings.mirrorCamera) {
    recCtx.save();
    recCtx.translate(recCanvas.width, 0);
    recCtx.scale(-1, 1);
  }

  recCtx.filter = settings.grayscaleMode ? 'grayscale(1)' : 'none';
  recCtx.drawImage(videoElement, 0, 0, recCanvas.width, recCanvas.height);
  recCtx.filter = 'none';

  // Both video and overlay share the same transform, so overlay pixels
  // are correctly mirrored to match what the user sees on screen.
  recCtx.drawImage(overlayCanvas, 0, 0);

  if (settings.mirrorCamera) recCtx.restore();
}

// Decide whether to start or schedule-stop the MediaRecorder based on motion level.
function handleAutoRecord(motionPercent, settings) {
  if (!settings.autoRecordEnabled) {
    if (state.isRecording) stopRecording();
    return;
  }

  const isAboveThreshold = motionPercent >= settings.alertThresholdPercent;

  if (isAboveThreshold) {
    if (!state.isRecording) startRecording();

    // Motion is still active — cancel any pending stop timer
    if (state.recordingStopTimeoutId !== null) {
      clearTimeout(state.recordingStopTimeoutId);
      state.recordingStopTimeoutId = null;
    }
  } else if (state.isRecording && state.recordingStopTimeoutId === null) {
    // Motion dropped below threshold — stop after a 3-second trailing window
    state.recordingStopTimeoutId = setTimeout(() => {
      stopRecording();
      state.recordingStopTimeoutId = null;
    }, 3000);
  }
}

function startRecording() {
  if (state.isRecording || !state.recordingCanvas) return;

  if (typeof state.recordingCanvas.captureStream !== 'function') {
    console.warn('canvas.captureStream() is not supported in this browser — auto-record unavailable.');
    return;
  }

  const stream = state.recordingCanvas.captureStream(30);

  const supportedMimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(mimeType => MediaRecorder.isTypeSupported(mimeType));

  const recorderOptions = supportedMimeType ? { mimeType: supportedMimeType } : {};

  state.recordedChunks  = [];
  state.mediaRecorder   = new MediaRecorder(stream, recorderOptions);

  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) state.recordedChunks.push(event.data);
  };

  state.mediaRecorder.onstop = downloadRecording;
  state.mediaRecorder.start(100); // collect data in 100 ms chunks

  state.isRecording = true;
  updateRecordingIndicator(true);
}

function stopRecording() {
  if (!state.isRecording || !state.mediaRecorder) return;

  if (state.recordingStopTimeoutId !== null) {
    clearTimeout(state.recordingStopTimeoutId);
    state.recordingStopTimeoutId = null;
  }

  state.mediaRecorder.stop(); // triggers onstop → downloadRecording
  state.isRecording = false;
  updateRecordingIndicator(false);
}

function downloadRecording() {
  if (state.recordedChunks.length === 0) return;

  const blob             = new Blob(state.recordedChunks, { type: 'video/webm' });
  const objectUrl        = URL.createObjectURL(blob);
  const downloadAnchor   = document.createElement('a');
  const isoTimestamp     = new Date().toISOString().replace(/[:.]/g, '-');

  downloadAnchor.download = `motion-clip-${isoTimestamp}.webm`;
  downloadAnchor.href     = objectUrl;
  downloadAnchor.click();

  URL.revokeObjectURL(objectUrl);
  state.recordedChunks = [];
}

function updateRecordingIndicator(isRecording) {
  recordingStatusRow.style.display = isRecording ? 'flex' : 'none';
}

// ── Event listeners ─────────────────────────────────────────────────────────
startStopBtn.addEventListener('click', () => {
  state.isRunning ? stopCamera() : startCamera();
});

toggleHudBtn.addEventListener('click', () => {
  hudPanel.classList.toggle('collapsed');
});

resetPeakBtn.addEventListener('click', () => {
  state.peakMotionPercent = 0;
  peakPercentDisplay.textContent = '0%';
});

snapshotBtn.addEventListener('click', takeSnapshot);

clearLogBtn.addEventListener('click', clearEventLog);

sensitivitySlider.addEventListener('input', () => {
  sensitivityValueLabel.textContent = sensitivitySlider.value;
  state.previousFrameData = null; // flush prev frame so new threshold takes effect cleanly
});

noiseReductionSlider.addEventListener('input', () => {
  state.previousFrameData = null; // flush prev frame so new blur takes effect cleanly
  noiseReductionValueLabel.textContent = `${noiseReductionSlider.value}px`;
});

overlayOpacitySlider.addEventListener('input', () => {
  overlayOpacityValueLabel.textContent = `${overlayOpacitySlider.value}%`;
});

overlayModeSelect.addEventListener('change', () => {
  overlayColorRow.style.display = overlayModeSelect.value === 'heatmap' ? 'none' : 'flex';
});

// Show the trigger-threshold section when either alert or auto-record needs it
function updateThresholdSectionVisibility() {
  const shouldShow = alertToggle.checked || autoRecordToggle.checked;
  alertThresholdSection.style.display = shouldShow ? 'flex' : 'none';
}

alertToggle.addEventListener('change', () => {
  updateThresholdSectionVisibility();
  if (!alertToggle.checked) state.wasAboveAlertThreshold = false;
});

autoRecordToggle.addEventListener('change', () => {
  updateThresholdSectionVisibility();
  if (!autoRecordToggle.checked && state.isRecording) stopRecording();
});

alertThresholdSlider.addEventListener('input', () => {
  alertThresholdValueLabel.textContent = `${alertThresholdSlider.value}%`;
});
