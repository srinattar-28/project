/* ==========================================================================
   Remote Board Monitoring — Dashboard Logic
   ==========================================================================
   Sections:
     1. Configuration (thresholds, chart settings)
     2. Data-handling layer (telemetry store, mock generator, API hooks)
     3. Status / severity detection
     4. Chart rendering
     5. Live value + summary card rendering
     6. Alerts table
     7. CSV export
     8. Bootstrap
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. CONFIGURATION
   *
   * Single source of truth for thresholds. Referenced everywhere else —
   * never hard-code a threshold number outside this object.
   * ------------------------------------------------------------------ */

  const thresholds = {
    temperature: {
      warning: 60,   // °C
      critical: 70,  // °C
    },
    pressure: {
      warningLow: 1000,  // hPa
      criticalLow: 980,  // hPa
    },
    imu: {
      warning: 2.5,  // g (RMS)
      critical: 3.5, // g (RMS)
    },
  };

  const CONFIG = {
    deviceId: "NODE-001",
    maxHistoryPoints: 40,     // points kept per chart / stat window
    maxAlerts: 25,            // rows kept in the alerts table
    updateIntervalMs: 2000,   // mock telemetry tick rate
    // TODO: Replace with the real REST/WebSocket base URL when available.
    apiBaseUrl: "/api",
  };

  /* ------------------------------------------------------------------ *
   * 2. DATA-HANDLING LAYER
   *
   * Everything downstream (charts, cards, alerts) consumes telemetry
   * only through `store` and `onTelemetry`. This is the seam to swap
   * mock data for a real backend without touching the rest of the UI.
   * ------------------------------------------------------------------ */

  const store = {
    history: [],           // array of telemetry frames, oldest first
    listeners: [],
  };

  function onTelemetry(callback) {
    store.listeners.push(callback);
  }

  function pushTelemetry(frame) {
    store.history.push(frame);
    if (store.history.length > CONFIG.maxHistoryPoints) {
      store.history.shift();
    }
    store.listeners.forEach((cb) => cb(frame, store.history));
  }

  /**
   * Expected telemetry frame shape (matches the backend contract):
   * {
   *   device_id: "NODE-001",
   *   timestamp: "2026-09-25T10:42:18",
   *   temperature: 42.6,
   *   pressure: 1012.4,
   *   imu: {
   *     accel_x, accel_y, accel_z,
   *     gyro_x, gyro_y, gyro_z
   *   }
   * }
   */

  // ---- Mock telemetry generator -------------------------------------
  // Values drift gradually (random walk + gentle mean reversion) so the
  // dashboard looks like a live sensor rather than random noise.

  const mockState = {
    temperature: 41.5,
    pressure: 1011.5,
    accel: { x: 0.1, y: -0.03, z: 9.81 },
    gyro: { x: 0.2, y: 0.1, z: -0.05 },
  };

  function drift(current, target, wobble, step) {
    const pull = (target - current) * 0.02;
    const noise = (Math.random() - 0.5) * step;
    return current + pull + noise + (Math.random() - 0.5) * wobble * 0.05;
  }

  function generateMockFrame() {
    mockState.temperature = drift(mockState.temperature, 42, 0.3, 0.25);
    mockState.pressure = drift(mockState.pressure, 1012, 0.4, 0.35);
    mockState.accel.x = drift(mockState.accel.x, 0.1, 0.05, 0.02);
    mockState.accel.y = drift(mockState.accel.y, -0.03, 0.05, 0.02);
    mockState.accel.z = drift(mockState.accel.z, 9.81, 0.05, 0.02);
    mockState.gyro.x = drift(mockState.gyro.x, 0.2, 0.05, 0.03);
    mockState.gyro.y = drift(mockState.gyro.y, 0.1, 0.05, 0.03);
    mockState.gyro.z = drift(mockState.gyro.z, -0.05, 0.05, 0.03);

    // Occasionally nudge a value toward a warning/critical excursion so
    // the alert pipeline and status badges are visibly exercised.
    if (Math.random() < 0.03) {
      mockState.temperature += 18 + Math.random() * 10;
    }
    if (Math.random() < 0.02) {
      mockState.pressure -= 15 + Math.random() * 15;
    }

    return {
      device_id: CONFIG.deviceId,
      timestamp: new Date().toISOString(),
      temperature: round(mockState.temperature, 1),
      pressure: round(mockState.pressure, 1),
      imu: {
        accel_x: round(mockState.accel.x, 2),
        accel_y: round(mockState.accel.y, 2),
        accel_z: round(mockState.accel.z, 2),
        gyro_x: round(mockState.gyro.x, 2),
        gyro_y: round(mockState.gyro.y, 2),
        gyro_z: round(mockState.gyro.z, 2),
      },
    };
  }

  let mockTimer = null;

  function startMockTelemetry() {
    // TODO: Replace mockTelemetry() with backend WebSocket data.
    // e.g. const socket = new WebSocket(CONFIG.apiBaseUrl.replace(/^http/, "ws") + "/telemetry/stream");
    //      socket.onmessage = (evt) => pushTelemetry(JSON.parse(evt.data));
    mockTimer = setInterval(() => {
      pushTelemetry(generateMockFrame());
    }, CONFIG.updateIntervalMs);
  }

  function stopMockTelemetry() {
    if (mockTimer) clearInterval(mockTimer);
  }

  // ---- Real backend integration point (disabled until available) ----
  // TODO: Once the backend exposes a REST/WebSocket telemetry endpoint,
  // implement this and call it instead of startMockTelemetry() below.
  //
  // function connectLiveTelemetry() {
  //   const socket = new WebSocket(`${CONFIG.apiBaseUrl}/telemetry/stream`);
  //   socket.onopen = () => setConnectionState("online");
  //   socket.onclose = () => setConnectionState("offline");
  //   socket.onmessage = (evt) => pushTelemetry(JSON.parse(evt.data));
  // }

  /* ------------------------------------------------------------------ *
   * 3. STATUS / SEVERITY DETECTION
   * ------------------------------------------------------------------ */

  function imuRms({ accel_x, accel_y, accel_z }) {
    return Math.sqrt(accel_x ** 2 + accel_y ** 2 + accel_z ** 2);
  }

  function temperatureStatus(value) {
    if (value >= thresholds.temperature.critical) return "critical";
    if (value >= thresholds.temperature.warning) return "warning";
    return "normal";
  }

  function pressureStatus(value) {
    if (value <= thresholds.pressure.criticalLow) return "critical";
    if (value <= thresholds.pressure.warningLow) return "warning";
    return "normal";
  }

  function imuStatus(rms) {
    if (rms >= thresholds.imu.critical) return "critical";
    if (rms >= thresholds.imu.warning) return "warning";
    return "normal";
  }

  /* ------------------------------------------------------------------ *
   * 4. CHART RENDERING
   *
   * Uses native Canvas so the dashboard works both through Flask and when
   * index.html is opened directly. No external chart library is required.
   * ------------------------------------------------------------------ */

  const charts = {};

  function initCharts() {
    charts.temperature = createCanvasChart("temperatureChart", {
      title: "Temperature",
      unit: "°C",
      series: [{ key: "temperature", label: "Temperature", className: "temp" }],
      warning: thresholds.temperature.warning,
      critical: thresholds.temperature.critical,
      warningDirection: "high",
    });

    charts.pressure = createCanvasChart("pressureChart", {
      title: "Barometer",
      unit: "hPa",
      series: [{ key: "pressure", label: "Pressure", className: "pressure" }],
      warning: thresholds.pressure.warningLow,
      critical: thresholds.pressure.criticalLow,
      warningDirection: "low",
    });

    charts.imu = createCanvasChart("imuChart", {
      title: "IMU Acceleration",
      unit: "g",
      series: [
        { key: "accel_x", label: "X", className: "imu-x" },
        { key: "accel_y", label: "Y", className: "imu-y" },
        { key: "accel_z", label: "Z", className: "imu-z" },
      ],
    });
  }

  function createCanvasChart(id, config) {
    const canvas = document.getElementById(id);
    const wrap = canvas?.parentElement;
    if (!canvas || !wrap) return null;

    const dpr = window.devicePixelRatio || 1;

    function resize() {
      const width = Math.max(280, wrap.clientWidth);
      const height = Math.max(150, wrap.clientHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    resize();
    window.addEventListener("resize", resize);

    return { canvas, config, dpr };
  }

  function drawAllCharts(history) {
    drawCanvasChart(charts.temperature, history);
    drawCanvasChart(charts.pressure, history);
    drawCanvasChart(charts.imu, history);
  }

  function drawCanvasChart(chart, history) {
    if (!chart || !history.length) return;

    const { canvas, config, dpr } = chart;
    const ctx = canvas.getContext("2d");
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pad = { top: 12, right: 14, bottom: 28, left: 42 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const values = [];
    config.series.forEach((series) => {
      history.forEach((frame) => {
        const value = series.key === "accel_x"
          ? frame.imu.accel_x
          : series.key === "accel_y"
            ? frame.imu.accel_y
            : series.key === "accel_z"
              ? frame.imu.accel_z
              : frame[series.key];

        if (Number.isFinite(value)) values.push(value);
      });
    });

    if (Number.isFinite(config.warning)) values.push(config.warning);
    if (Number.isFinite(config.critical)) values.push(config.critical);

    let min = Math.min(...values);
    let max = Math.max(...values);

    if (config.warningDirection === "low") {
      min = Math.min(min, config.critical, config.warning);
      max = Math.max(max, ...values);
    }

    const range = Math.max(max - min, 1);
    min -= range * 0.08;
    max += range * 0.08;

    // Grid
    ctx.strokeStyle = "#eef1f5";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#8a93a3";
    ctx.font = "10px Segoe UI, Arial";

    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();

      const value = max - ((max - min) * i) / 4;
      ctx.fillText(formatChartNumber(value), 4, y + 3);
    }

    // Threshold lines
    if (Number.isFinite(config.warning)) {
      drawThreshold(ctx, config.warning, min, max, pad, plotW, plotH, "#b7791f", "Warning");
    }
    if (Number.isFinite(config.critical)) {
      drawThreshold(ctx, config.critical, min, max, pad, plotW, plotH, "#c0322a", "Critical");
    }

    // Data series
    const seriesColors = ["#2563eb", "#7c3aed", "#0891b2"];

    config.series.forEach((series, seriesIndex) => {
      const points = history.map((frame, index) => {
        const value = series.key === "accel_x"
          ? frame.imu.accel_x
          : series.key === "accel_y"
            ? frame.imu.accel_y
            : series.key === "accel_z"
              ? frame.imu.accel_z
              : frame[series.key];

        const x = pad.left + (history.length === 1 ? plotW / 2 : (plotW * index) / (history.length - 1));
        const y = pad.top + ((max - value) / (max - min)) * plotH;
        return { x, y };
      });

      ctx.strokeStyle = seriesColors[seriesIndex % seriesColors.length];
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();

      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });

      ctx.stroke();
    });

    // X-axis labels
    ctx.fillStyle = "#8a93a3";
    ctx.font = "10px Segoe UI, Arial";

    const labelCount = Math.min(5, history.length);
    for (let i = 0; i < labelCount; i++) {
      const index = Math.round((history.length - 1) * (i / Math.max(labelCount - 1, 1)));
      const x = pad.left + (plotW * index) / Math.max(history.length - 1, 1);
      ctx.fillText(formatTime(history[index].timestamp), x - 18, height - 8);
    }

    // Legend
    let legendX = pad.left;
    const legendY = 8;
    config.series.forEach((series, index) => {
      ctx.fillStyle = seriesColors[index % seriesColors.length];
      ctx.fillRect(legendX, legendY, 9, 2);
      ctx.fillStyle = "#5b6577";
      ctx.fillText(series.label, legendX + 13, legendY + 4);
      legendX += 50;
    });
  }

  function drawThreshold(ctx, value, min, max, pad, plotW, plotH, color, label) {
    if (value < min || value > max) return;
    const y = pad.top + ((max - value) / (max - min)) * plotH;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.font = "9px Segoe UI, Arial";
    ctx.fillText(label, pad.left + 4, y - 4);
  }

  function formatChartNumber(value) {
    if (Math.abs(value) >= 100) return value.toFixed(0);
    if (Math.abs(value) >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function updateCharts(history) {
    drawAllCharts(history);
  }

  /* ------------------------------------------------------------------ *
   * 5. LIVE VALUE + SUMMARY CARD RENDERING
   * ------------------------------------------------------------------ */

  function stats(values) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { min, max, avg };
  }

  function setStatusBadge(el, status) {
    el.dataset.status = status;
    el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  }

  function setTrend(el, series) {
    if (series.length < 2) {
      el.dataset.direction = "flat";
      el.textContent = "—";
      return;
    }
    const delta = series[series.length - 1] - series[series.length - 2];
    if (Math.abs(delta) < 0.001) {
      el.dataset.direction = "flat";
      el.textContent = "—";
    } else if (delta > 0) {
      el.dataset.direction = "up";
      el.textContent = "▲";
    } else {
      el.dataset.direction = "down";
      el.textContent = "▼";
    }
  }

  function renderLiveValues(frame, history) {
    // ---- Temperature ----
    const tempSeries = history.map((f) => f.temperature);
    const tempStat = stats(tempSeries);
    const tStatus = temperatureStatus(frame.temperature);

    $("#tempCurrentValue").textContent = frame.temperature.toFixed(1);
    $("#tempBigValue").textContent = frame.temperature.toFixed(1);
    $("#tempMin").textContent = `${tempStat.min.toFixed(1)} °C`;
    $("#tempMax").textContent = `${tempStat.max.toFixed(1)} °C`;
    $("#tempAvg").textContent = `${tempStat.avg.toFixed(1)} °C`;
    setStatusBadge($("#tempStatusBadge"), tStatus);
    setStatusBadge(document.querySelector('[data-sensor="temperature"] .status-badge'), tStatus);
    setTrend($("#tempTrend"), tempSeries);

    // ---- Pressure ----
    const pressureSeries = history.map((f) => f.pressure);
    const pressureStat = stats(pressureSeries);
    const pStatus = pressureStatus(frame.pressure);

    $("#pressureCurrentValue").textContent = frame.pressure.toFixed(1);
    $("#pressureBigValue").textContent = frame.pressure.toFixed(1);
    $("#pressureMin").textContent = `${pressureStat.min.toFixed(1)} hPa`;
    $("#pressureMax").textContent = `${pressureStat.max.toFixed(1)} hPa`;
    $("#pressureAvg").textContent = `${pressureStat.avg.toFixed(1)} hPa`;
    setStatusBadge($("#pressureStatusBadge"), pStatus);
    setStatusBadge(document.querySelector('[data-sensor="pressure"] .status-badge'), pStatus);
    setTrend($("#pressureTrend"), pressureSeries);

    // ---- IMU ----
    const rms = imuRms(frame.imu);
    const rmsSeries = history.map((f) => imuRms(f.imu));
    const iStatus = imuStatus(rms);

    $("#imuCurrentValue").textContent = rms.toFixed(2);
    $("#accelX").textContent = `${frame.imu.accel_x.toFixed(2)} g`;
    $("#accelY").textContent = `${frame.imu.accel_y.toFixed(2)} g`;
    $("#accelZ").textContent = `${frame.imu.accel_z.toFixed(2)} g`;
    $("#gyroX").textContent = `${frame.imu.gyro_x.toFixed(2)} °/s`;
    $("#gyroY").textContent = `${frame.imu.gyro_y.toFixed(2)} °/s`;
    $("#gyroZ").textContent = `${frame.imu.gyro_z.toFixed(2)} °/s`;
    $("#imuRmsValue").textContent = rms.toFixed(2);
    setStatusBadge($("#imuStatusBadge"), iStatus);
    setStatusBadge(document.querySelector('[data-sensor="imu"] .status-badge'), iStatus);
    setTrend($("#imuTrend"), rmsSeries);

    $("#lastUpdated").textContent = formatTime(frame.timestamp, true);
  }

  /* ------------------------------------------------------------------ *
   * 6. ALERTS TABLE
   * ------------------------------------------------------------------ */

  const alerts = [];
  const lastStatusBySensor = { temperature: "normal", pressure: "normal", imu: "normal" };

  function maybeRaiseAlert(sensorKey, label, value, unit, status, thresholdText) {
    const previous = lastStatusBySensor[sensorKey];
    lastStatusBySensor[sensorKey] = status;

    if (status === "normal") return; // no alert for normal readings
    if (status === previous) return; // only log on transition, avoid spam

    const messages = {
      warning: `${label} approaching threshold`,
      critical: `${label} exceeded critical limit`,
    };

    alerts.unshift({
      time: formatTime(new Date().toISOString(), true),
      sensor: label,
      value: `${value} ${unit}`,
      threshold: thresholdText,
      severity: status,
      active: true,
      message: messages[status],
    });

    if (alerts.length > CONFIG.maxAlerts) alerts.pop();
    renderAlerts();
  }

  function renderAlerts() {
    const tbody = $("#alertsTableBody");
    if (alerts.length === 0) {
      tbody.innerHTML = `<tr class="alerts-empty-row"><td colspan="7">No alerts recorded yet.</td></tr>`;
      $("#alertCount").textContent = "0 active";
      return;
    }

    tbody.innerHTML = alerts
      .map(
        (a) => `
        <tr>
          <td>${a.time}</td>
          <td>${a.sensor}</td>
          <td>${a.value}</td>
          <td>${a.threshold}</td>
          <td><span class="severity-pill" data-severity="${a.severity}">${capitalize(a.severity)}</span></td>
          <td><span class="row-status" data-active="${a.active}">${a.active ? "Active" : "Resolved"}</span></td>
          <td>${a.message}</td>
        </tr>`
      )
      .join("");

    const activeCount = alerts.filter((a) => a.active).length;
    $("#alertCount").textContent = `${activeCount} active`;
  }

  function evaluateAlerts(frame) {
    const tStatus = temperatureStatus(frame.temperature);
    maybeRaiseAlert(
      "temperature",
      "Temperature",
      frame.temperature.toFixed(1),
      "°C",
      tStatus,
      tStatus === "critical" ? `>${thresholds.temperature.critical}°C` : `>${thresholds.temperature.warning}°C`
    );

    const pStatus = pressureStatus(frame.pressure);
    maybeRaiseAlert(
      "pressure",
      "Barometer",
      frame.pressure.toFixed(1),
      "hPa",
      pStatus,
      pStatus === "critical" ? `<${thresholds.pressure.criticalLow}hPa` : `<${thresholds.pressure.warningLow}hPa`
    );

    const rms = imuRms(frame.imu);
    const iStatus = imuStatus(rms);
    maybeRaiseAlert(
      "imu",
      "IMU",
      rms.toFixed(2),
      "g",
      iStatus,
      iStatus === "critical" ? `>${thresholds.imu.critical}g` : `>${thresholds.imu.warning}g`
    );
  }

  /* ------------------------------------------------------------------ *
   * 7. CSV EXPORT
   *
   * Calls the backend export endpoint provided by csv_export.py.
   * If that endpoint isn't available yet, falls back to exporting the
   * telemetry currently held in the browser so the UI is usable today.
   * ------------------------------------------------------------------ */

  async function requestCsvExport({ sensor, start, end }) {
    const params = new URLSearchParams({ sensor, start: start || "", end: end || "" });

    // TODO: Confirm the exact route exposed by csv_export.py and adjust
    // this path if it differs (e.g. /export, /api/csv, /csv_export).
    const endpoint = `${CONFIG.apiBaseUrl}/export/csv?${params.toString()}`;

    try {
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`Export endpoint returned ${response.status}`);
      const blob = await response.blob();
      downloadBlob(blob, buildExportFilename(sensor));
      return { ok: true, source: "backend" };
    } catch (err) {
      // Backend not reachable yet — export what's currently in memory
      // so the interface stays functional during frontend development.
      const csv = buildCsvFromHistory(sensor, start, end);
      downloadBlob(new Blob([csv], { type: "text/csv" }), buildExportFilename(sensor));
      return { ok: true, source: "local-fallback", error: err.message };
    }
  }

  function buildCsvFromHistory(sensor, start, end) {
    const startTime = start ? new Date(start).getTime() : -Infinity;
    const endTime = end ? new Date(end).getTime() : Infinity;

    const rows = store.history.filter((f) => {
      const t = new Date(f.timestamp).getTime();
      return t >= startTime && t <= endTime;
    });

    const header = [
      "timestamp",
      "device_id",
      ...(sensor === "all" || sensor === "temperature" ? ["temperature_c"] : []),
      ...(sensor === "all" || sensor === "pressure" ? ["pressure_hpa"] : []),
      ...(sensor === "all" || sensor === "imu"
        ? ["accel_x_g", "accel_y_g", "accel_z_g", "gyro_x_dps", "gyro_y_dps", "gyro_z_dps"]
        : []),
    ];

    const lines = [header.join(",")];
    rows.forEach((f) => {
      const cols = [f.timestamp, f.device_id];
      if (sensor === "all" || sensor === "temperature") cols.push(f.temperature);
      if (sensor === "all" || sensor === "pressure") cols.push(f.pressure);
      if (sensor === "all" || sensor === "imu") {
        cols.push(f.imu.accel_x, f.imu.accel_y, f.imu.accel_z, f.imu.gyro_x, f.imu.gyro_y, f.imu.gyro_z);
      }
      lines.push(cols.join(","));
    });

    return lines.join("\n");
  }

  function buildExportFilename(sensor) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `telemetry_${sensor}_${stamp}.csv`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function bindExportForm() {
    const form = $("#exportForm");
    const statusEl = $("#exportStatus");
    const button = $("#exportButton");

    form.addEventListener("submit", async (evt) => {
      evt.preventDefault();
      const sensor = $("#exportSensor").value;
      const start = $("#exportStart").value;
      const end = $("#exportEnd").value;

      button.disabled = true;
      statusEl.dataset.state = "";
      statusEl.textContent = "Preparing export…";

      try {
        const result = await requestCsvExport({ sensor, start, end });
        statusEl.dataset.state = "success";
        statusEl.textContent =
          result.source === "backend"
            ? "Export complete."
            : "Export complete (using local telemetry — backend export endpoint not connected yet).";
      } catch (err) {
        statusEl.dataset.state = "error";
        statusEl.textContent = `Export failed: ${err.message}`;
      } finally {
        button.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 8. BOOTSTRAP
   * ------------------------------------------------------------------ */

  function $(selector) {
    return document.querySelector(selector);
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatTime(isoString, withDate = false) {
    const d = new Date(isoString);
    if (withDate) {
      return d.toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function setConnectionState(state) {
    const el = $("#connectionStatus");
    el.dataset.state = state;
    el.querySelector(".status-text").textContent = state.toUpperCase();
  }

  function init() {
    initCharts();
    bindExportForm();
    setConnectionState("online");

    onTelemetry((frame, history) => {
      updateCharts(history);
      renderLiveValues(frame, history);
      evaluateAlerts(frame);
    });

    // Show the first telemetry sample immediately.
    pushTelemetry(generateMockFrame());

    // Continue generating live mock telemetry until the real backend is connected.
    startMockTelemetry();

    window.addEventListener("beforeunload", stopMockTelemetry);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
