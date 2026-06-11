// BTC100-2S Spectrometer Diagnostic Application
// WebSerial-based communication with B&W Tek BTC100-2S spectrometer

class SpectrographDiagnostic {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        this.isContinuousScanning = false;
        this.chart = null;
        this.currentData = null;
        this.currentAnalysis = null;
        this.currentWavelengths = null;
        this.currentSpectrumColumns = null;
        this.currentScanMetadata = null;
        this.currentStoredScanId = null;
        this.calibrationPeaks = [];
        this.lastCalibrationFit = null;
        this.xDomainMin = 0;
        this.xDomainMax = 2047;
        this.xViewMin = null;
        this.xViewMax = null;
        this.isPanningChart = false;
        this.panStartClientX = 0;
        this.panStartMin = 0;
        this.panStartMax = 0;
        this.panPointerId = null;
        this.asciiMode = true;
        this.pendingQueryParam = null;
        this.awaitingBinaryScan = false;
        this.textBuffer = '';
        this.binaryBuffer = new Uint8Array();
        this.baudRate = 9600;
        this.pendingBaudRate = 9600;
        this.axisCalibrationStorageKey = 'spectrotoyAxisCalibration';
        this.settingsStorageKey = 'spectrotoyControlSettings';
        this.scanDbName = 'spectrotoyLocalScans';
        this.scanDbVersion = 1;
        this.scanStoreName = 'scans';
        this.scanDbPromise = null;
        this.storedScans = [];
        this.scanStartTime = 0;
        this.lastBinaryByteTime = 0;
        this.lastScanCommandTime = 0;
        this.lastPreviewRenderTime = 0;
        this.consecutiveScanTimeouts = 0;
        this.baudRateMap = {
            115200: 0,
            38400: 1,
            19200: 2,
            9600: 3,
            4800: 4,
            2400: 5,
            1200: 6,
            600: 7
        };
        
        // Pixel to wavelength calibration. Start uncalibrated so raw scans are not
        // labeled as wavelength data until the operator opts into a mapping.
        this.calibrationMode = 'pixel';
        this.wavelengthMin = 400;
        this.wavelengthMax = 580;
        this.pixelCount = 2048;
        
        this.initializeChart();
    }

    log(message, type = 'info') {
        const logContainer = document.getElementById('logContainer');
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
        
        // Keep only last 50 entries
        while (logContainer.children.length > 50) {
            logContainer.removeChild(logContainer.firstChild);
        }
    }

    createPeakLabelPlugin() {
        return {
            id: 'peakLabels',
            afterDatasetsDraw: (chart) => {
                const peakDatasetIndex = chart.data.datasets.findIndex(dataset => dataset.label === 'Detected Peaks');
                if (peakDatasetIndex < 0) return;

                const meta = chart.getDatasetMeta(peakDatasetIndex);
                const dataset = chart.data.datasets[peakDatasetIndex];
                if (meta.hidden || dataset.hidden || !dataset.data.length) return;

                const { ctx, chartArea, scales } = chart;
                const xScale = scales.x;
                const yScale = scales.y;

                ctx.save();
                ctx.font = '700 11px Manrope, Segoe UI, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';

                dataset.data.forEach(point => {
                    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

                    const x = xScale.getPixelForValue(point.x);
                    const y = Math.max(chartArea.top + 16, yScale.getPixelForValue(point.y) - 8);
                    const label = `${Math.round(point.x)}`;
                    const width = ctx.measureText(label).width + 8;
                    const height = 15;

                    if (x < chartArea.left || x > chartArea.right) return;

                    ctx.fillStyle = 'rgba(9, 19, 31, 0.82)';
                    ctx.strokeStyle = 'rgba(249, 226, 175, 0.46)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    if (typeof ctx.roundRect === 'function') {
                        ctx.roundRect(x - width / 2, y - height, width, height, 4);
                    } else {
                        ctx.rect(x - width / 2, y - height, width, height);
                    }
                    ctx.fill();
                    ctx.stroke();

                    ctx.fillStyle = '#f9e2af';
                    ctx.fillText(label, x, y - 3);
                });

                ctx.restore();
            }
        };
    }

    initializeChart() {
        const ctx = document.getElementById('spectrumChart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Raw Intensity',
                    data: [],
                    borderColor: '#1f8fff',
                    backgroundColor: 'rgba(31, 143, 255, 0.08)',
                    borderWidth: 1.5,
                    fill: false,
                    tension: 0.18,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    spanGaps: false,
                    parsing: false
                }, {
                    label: 'Processed',
                    data: [],
                    borderColor: '#a6e3a1',
                    backgroundColor: 'rgba(166, 227, 161, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.12,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    spanGaps: false,
                    parsing: false
                }, {
                    label: 'Baseline',
                    data: [],
                    borderColor: '#fab387',
                    borderDash: [6, 5],
                    borderWidth: 1.25,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    fill: false,
                    parsing: false
                }, {
                    label: 'Detected Peaks',
                    data: [],
                    borderColor: '#f9e2af',
                    backgroundColor: '#f9e2af',
                    pointRadius: 4,
                    pointHoverRadius: 5,
                    showLine: false,
                    parsing: false
                }, {
                    label: 'Scan Cursor',
                    data: [],
                    borderColor: '#ffd166',
                    borderWidth: 1,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    fill: false,
                    parsing: false
                }]
            },
            plugins: [this.createPeakLabelPlugin()],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                events: ['click'],
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'start',
                        labels: {
                            color: '#c8d4e3',
                            usePointStyle: true,
                            boxWidth: 10,
                            filter: (legendItem) => legendItem.text !== 'Scan Cursor'
                        }
                    },
                    tooltip: {
                        intersect: false,
                        mode: 'index',
                        callbacks: {
                            title: (items) => {
                                if (!items.length) return '';
                                const unit = this.currentAnalysis?.processed?.length ? 'cm⁻¹' : this.getXAxisUnit();
                                return `${items[0].parsed.x.toFixed(1)} ${unit}`;
                            },
                            label: (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(4)}`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Sensor Pixel',
                            color: '#8ea2b8'
                        },
                        min: 0,
                        max: this.pixelCount - 1,
                        ticks: {
                            color: '#8ea2b8',
                            maxTicksLimit: 10
                        },
                        grid: {
                            color: 'rgba(110, 129, 154, 0.14)'
                        },
                        border: {
                            color: 'rgba(110, 129, 154, 0.25)'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Intensity (counts)',
                            color: '#8ea2b8'
                        },
                        min: 0,
                        beginAtZero: true,
                        ticks: {
                            color: '#8ea2b8'
                        },
                        grid: {
                            color: 'rgba(110, 129, 154, 0.12)'
                        },
                        border: {
                            color: 'rgba(110, 129, 154, 0.25)'
                        }
                    }
                }
            }
        });
        this.setupChartInteractions();
    }

    setupChartInteractions() {
        const canvas = document.getElementById('spectrumChart');
        if (!canvas) return;

        canvas.addEventListener('wheel', event => {
            if (!this.currentData && !this.currentAnalysis) return;
            event.preventDefault();

            const chartArea = this.chart.chartArea;
            if (!chartArea) return;

            const xValue = this.chart.scales.x.getValueForPixel(event.offsetX);
            if (!Number.isFinite(xValue)) return;

            if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && this.isXZoomed()) {
                this.panXByPixels(event.deltaX);
            } else {
                const zoomFactor = Math.exp(event.deltaY * 0.0015);
                this.zoomXAt(xValue, zoomFactor);
            }

            this.updateCursorFromEvent(event);
        }, { passive: false });

        canvas.addEventListener('pointerdown', event => {
            this.updateCursorFromEvent(event);
            if (event.pointerType !== 'mouse' || event.button !== 0) return;
            if (!this.isXZoomed()) return;

            this.isPanningChart = true;
            this.panPointerId = event.pointerId;
            this.panStartClientX = event.clientX;
            this.panStartMin = this.chart.options.scales.x.min;
            this.panStartMax = this.chart.options.scales.x.max;
            canvas.setPointerCapture?.(event.pointerId);
        });

        canvas.addEventListener('pointermove', event => {
            this.updateCursorFromEvent(event);
            if (!this.isPanningChart || event.pointerId !== this.panPointerId) return;
            event.preventDefault();
            const deltaPx = event.clientX - this.panStartClientX;
            this.panXFromStart(deltaPx);
        });

        const stopPan = event => {
            if (event.pointerId !== this.panPointerId) return;
            this.isPanningChart = false;
            this.panPointerId = null;
            canvas.releasePointerCapture?.(event.pointerId);
        };

        canvas.addEventListener('pointerup', stopPan);
        canvas.addEventListener('pointercancel', stopPan);
        canvas.addEventListener('pointerleave', event => {
            if (!this.isPanningChart) {
                this.clearChartCursor();
            } else {
                stopPan(event);
            }
        });

        canvas.addEventListener('dblclick', () => this.resetXZoom());
    }

    getXRange() {
        return this.xDomainMax - this.xDomainMin;
    }

    isXZoomed() {
        return this.xViewMin !== null && this.xViewMax !== null &&
            (Math.abs(this.xViewMin - this.xDomainMin) > 1e-9 || Math.abs(this.xViewMax - this.xDomainMax) > 1e-9);
    }

    setXDomain(min, max) {
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return;
        this.xDomainMin = min;
        this.xDomainMax = max;

        if (this.xViewMin === null || this.xViewMax === null) {
            this.chart.options.scales.x.min = min;
            this.chart.options.scales.x.max = max;
            return;
        }

        const width = Math.min(this.xViewMax - this.xViewMin, max - min);
        let nextMin = Math.max(min, Math.min(this.xViewMin, max - width));
        this.xViewMin = nextMin;
        this.xViewMax = nextMin + width;
        this.chart.options.scales.x.min = this.xViewMin;
        this.chart.options.scales.x.max = this.xViewMax;
    }

    applyXView(min, max) {
        const domainWidth = this.getXRange();
        const minWidth = Math.max(domainWidth / 200, 1e-9);
        let width = Math.max(minWidth, Math.min(max - min, domainWidth));
        let nextMin = Math.max(this.xDomainMin, Math.min(min, this.xDomainMax - width));

        this.xViewMin = nextMin;
        this.xViewMax = nextMin + width;
        this.chart.options.scales.x.min = this.xViewMin;
        this.chart.options.scales.x.max = this.xViewMax;
        this.chart.update('none');
    }

    zoomXAt(center, factor) {
        const currentMin = this.chart.options.scales.x.min;
        const currentMax = this.chart.options.scales.x.max;
        const currentWidth = currentMax - currentMin;
        if (!Number.isFinite(currentWidth) || currentWidth <= 0) return;

        const nextWidth = currentWidth * factor;
        const ratio = (center - currentMin) / currentWidth;
        const nextMin = center - nextWidth * ratio;
        this.applyXView(nextMin, nextMin + nextWidth);
    }

    panXByPixels(deltaPx) {
        const scale = this.chart.scales.x;
        const width = this.chart.options.scales.x.max - this.chart.options.scales.x.min;
        const deltaValue = (deltaPx / Math.max(1, scale.width)) * width;
        this.applyXView(this.chart.options.scales.x.min + deltaValue, this.chart.options.scales.x.max + deltaValue);
    }

    panXFromStart(deltaPx) {
        const scale = this.chart.scales.x;
        const width = this.panStartMax - this.panStartMin;
        const deltaValue = -(deltaPx / Math.max(1, scale.width)) * width;
        this.applyXView(this.panStartMin + deltaValue, this.panStartMax + deltaValue);
    }

    resetXZoom() {
        this.xViewMin = null;
        this.xViewMax = null;
        this.chart.options.scales.x.min = this.xDomainMin;
        this.chart.options.scales.x.max = this.xDomainMax;
        this.chart.update('none');
    }

    updateCursorFromEvent(event) {
        if (!this.chart?.chartArea) return;
        const area = this.chart.chartArea;
        const rect = this.chart.canvas.getBoundingClientRect();
        const xPixel = event.clientX - rect.left;
        const yPixel = event.clientY - rect.top;
        if (xPixel < area.left || xPixel > area.right || yPixel < area.top || yPixel > area.bottom) {
            this.clearChartCursor();
            return;
        }

        const xValue = this.chart.scales.x.getValueForPixel(xPixel);
        if (!Number.isFinite(xValue)) return;

        const { min: yMin, max: yMax } = this.getVisibleChartYBounds();
        this.chart.data.datasets[4].data = [
            { x: xValue, y: yMin },
            { x: xValue, y: yMax }
        ];

        this.activateNearestTooltipPoint(xValue);
        this.chart.update('none');
    }

    clearChartCursor() {
        if (!this.chart) return;
        this.chart.data.datasets[4].data = [];
        this.chart.setActiveElements([]);
        this.chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
        this.chart.update('none');
    }

    getVisibleChartYBounds() {
        const yScale = this.chart.scales.y;
        if (Number.isFinite(yScale?.min) && Number.isFinite(yScale?.max) && yScale.max > yScale.min) {
            return { min: yScale.min, max: yScale.max };
        }

        const datasets = this.chart.data.datasets.slice(0, 4);
        const bounds = datasets.reduce((best, dataset, datasetIndex) => {
            if (this.chart.getDatasetMeta(datasetIndex).hidden) return best;
            dataset.data.forEach(point => {
                const y = typeof point === 'number' ? point : point?.y;
                if (!Number.isFinite(y)) return;
                best.min = Math.min(best.min, y);
                best.max = Math.max(best.max, y);
            });
            return best;
        }, { min: 0, max: 1 });

        if (bounds.max <= bounds.min) bounds.max = bounds.min + 1;
        return bounds;
    }

    activateNearestTooltipPoint(xValue) {
        const activeElements = [];
        let anchorX = xValue;
        let anchorDistance = Infinity;

        this.chart.data.datasets.slice(0, 4).forEach((dataset, datasetIndex) => {
            if (this.chart.getDatasetMeta(datasetIndex).hidden) return;
            let best = null;

            dataset.data.forEach((point, index) => {
                if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
                const distance = Math.abs(point.x - xValue);
                if (!best || distance < best.distance) {
                    best = { datasetIndex, index, distance, x: point.x };
                }
            });

            if (!best) return;

            const xPixel = this.chart.scales.x.getPixelForValue(best.x);
            const cursorPixel = this.chart.scales.x.getPixelForValue(xValue);
            const pixelDistance = Math.abs(xPixel - cursorPixel);
            const isSparseMarkerDataset = dataset.showLine === false;
            if (isSparseMarkerDataset && pixelDistance > 10) return;

            activeElements.push({ datasetIndex: best.datasetIndex, index: best.index });
            if (best.distance < anchorDistance) {
                anchorDistance = best.distance;
                anchorX = best.x;
            }
        });

        if (!activeElements.length) return;

        const xPixel = this.chart.scales.x.getPixelForValue(anchorX);
        const yPixel = this.chart.chartArea.top + 8;
        this.chart.setActiveElements(activeElements);
        this.chart.tooltip?.setActiveElements(activeElements, {
            x: xPixel,
            y: yPixel
        });
    }

    pixelToWavelength(pixel) {
        if (Array.isArray(this.currentWavelengths) && this.currentWavelengths[pixel] !== undefined) {
            return this.currentWavelengths[pixel];
        }
        if (this.calibrationMode !== 'linear') {
            return NaN;
        }
        const denominator = Math.max(1, this.pixelCount - 1);
        return this.wavelengthMin + 
               (pixel / denominator) * (this.wavelengthMax - this.wavelengthMin);
    }

    wavelengthToPixel(wavelength) {
        const denominator = Math.max(1, this.pixelCount - 1);
        return Math.floor(((wavelength - this.wavelengthMin) / 
                (this.wavelengthMax - this.wavelengthMin)) * denominator);
    }

    updateCalibration(c0, c1, c2, c3, options = {}) {
        // Set polynomial calibration: wavelength = c0 + c1*p + c2*p^2 + c3*p^3
        this.currentWavelengths = null;
        this.calibrationMode = 'polynomial';
        this.c0 = c0;
        this.c1 = c1;
        this.c2 = c2;
        this.c3 = c3;
        if (options.silent !== true) {
            this.log(`Calibration updated: c0=${c0}, c1=${c1}, c2=${c2}, c3=${c3}`, 'info');
        }
    }

    pixelToWavelengthCalibrated(pixel) {
        if (Array.isArray(this.currentWavelengths) && this.currentWavelengths[pixel] !== undefined) {
            return this.currentWavelengths[pixel];
        }
        if (this.calibrationMode !== 'polynomial' || this.c1 === undefined) {
            return this.pixelToWavelength(pixel); // Use linear if not calibrated
        }
        return this.c0 + this.c1 * pixel + this.c2 * pixel * pixel + 
               this.c3 * pixel * pixel * pixel;
    }

    hasWavelengthCalibration() {
        return this.calibrationMode !== 'pixel' || Array.isArray(this.currentWavelengths);
    }

    getXAxisValue(pixel) {
        return this.hasWavelengthCalibration() ? this.pixelToWavelengthCalibrated(pixel) : pixel;
    }

    getXAxisLabel() {
        return this.hasWavelengthCalibration() ? 'Wavelength (nm)' : 'Sensor Pixel';
    }

    getXAxisUnit() {
        return this.hasWavelengthCalibration() ? 'nm' : 'px';
    }

    readNumberInput(id, fallback = NaN) {
        const value = parseFloat(document.getElementById(id)?.value);
        return Number.isFinite(value) ? value : fallback;
    }

    setInputValue(id, value) {
        const input = document.getElementById(id);
        if (input && value !== undefined && value !== null && Number.isFinite(Number(value))) {
            input.value = String(value);
        }
    }

    saveAxisCalibrationPreference(config) {
        try {
            localStorage.setItem(this.axisCalibrationStorageKey, JSON.stringify(config));
        } catch (error) {
            this.log(`Could not save axis calibration: ${error.message}`, 'error');
        }
    }

    loadAxisCalibrationPreference() {
        let config = null;
        try {
            const stored = localStorage.getItem(this.axisCalibrationStorageKey);
            config = stored ? JSON.parse(stored) : null;
        } catch (error) {
            this.log(`Could not load saved axis calibration: ${error.message}`, 'error');
            return;
        }

        if (!config || typeof config !== 'object') return;

        const modeSelect = document.getElementById('axisCalibrationMode');
        if (modeSelect && ['pixel', 'linear', 'polynomial'].includes(config.mode)) {
            modeSelect.value = config.mode;
        }

        this.setInputValue('wavelengthMin', config.wavelengthMin);
        this.setInputValue('wavelengthMax', config.wavelengthMax);
        this.setInputValue('calibrationC0', config.c0);
        this.setInputValue('calibrationC1', config.c1);
        this.setInputValue('calibrationC2', config.c2);
        this.setInputValue('calibrationC3', config.c3);

        this.applyAxisCalibration({ persist: false, silent: true });
        this.log(`Loaded saved ${config.mode} axis calibration`, 'info');
    }

    applyAxisCalibration(options = {}) {
        const persist = options.persist !== false;
        const silent = options.silent === true;
        const mode = document.getElementById('axisCalibrationMode')?.value || 'pixel';
        let config = { mode };

        if (mode === 'linear') {
            const min = this.readNumberInput('wavelengthMin', this.wavelengthMin);
            const max = this.readNumberInput('wavelengthMax', this.wavelengthMax);
            if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) {
                this.log('Linear wavelength range must have a valid min and max', 'error');
                return;
            }
            this.currentWavelengths = null;
            this.c0 = undefined;
            this.c1 = undefined;
            this.c2 = undefined;
            this.c3 = undefined;
            this.calibrationMode = 'linear';
            this.wavelengthMin = min;
            this.wavelengthMax = max;
            config = { mode, wavelengthMin: min, wavelengthMax: max };
            if (!silent) this.log(`Using assumed linear wavelength range ${min.toFixed(3)}-${max.toFixed(3)} nm`, 'info');
        } else if (mode === 'polynomial') {
            const c0 = this.readNumberInput('calibrationC0');
            const c1 = this.readNumberInput('calibrationC1');
            const c2 = this.readNumberInput('calibrationC2', 0);
            const c3 = this.readNumberInput('calibrationC3', 0);
            if (![c0, c1, c2, c3].every(Number.isFinite)) {
                this.log('Polynomial calibration requires numeric coefficients', 'error');
                return;
            }
            this.currentWavelengths = null;
            this.updateCalibration(c0, c1, c2, c3, { silent });
            config = { mode, c0, c1, c2, c3 };
        } else {
            this.currentWavelengths = null;
            this.c0 = undefined;
            this.c1 = undefined;
            this.c2 = undefined;
            this.c3 = undefined;
            this.calibrationMode = 'pixel';
            if (!silent) this.log('Using uncalibrated sensor pixel axis', 'info');
        }

        if (persist) {
            this.saveAxisCalibrationPreference(config);
            this.saveControlSettings();
        }
        this.syncAxisCalibrationUI();
        if (Array.isArray(this.currentData) && this.currentData.length > 0) {
            this.updateChart({ final: true });
            this.updateStatistics();
        }
    }

    findCalibrationPeaks() {
        if (!Array.isArray(this.currentData) || this.currentData.length < 3) {
            this.log('Load or acquire a reference spectrum before finding calibration peaks', 'error');
            return;
        }

        const maxValue = Math.max(...this.currentData);
        const minValue = Math.min(...this.currentData);
        const range = Math.max(maxValue - minValue, 1e-12);
        const normalized = this.currentData.map(value => (value - minValue) / range);
        const heightPercent = this.readNumberInput('calibrationPeakHeight', 12);
        const minDistance = Math.max(1, Math.round(this.readNumberInput('calibrationPeakDistance', 30)));
        const peakLimit = Math.max(2, Math.round(this.readNumberInput('calibrationPeakLimit', 12)));
        const minHeight = Math.max(0, Math.min(1, heightPercent / 100));

        const peaks = RamanProcessing.findPeaks(normalized, { minHeight, minDistance })
            .map(peak => this.refineCalibrationPeak(peak.index))
            .sort((a, b) => b.intensity - a.intensity)
            .slice(0, peakLimit)
            .sort((a, b) => a.pixel - b.pixel);

        this.calibrationPeaks = peaks.map(peak => ({
            ...peak,
            wavelength: '',
            residual: null,
            enabled: true
        }));
        this.lastCalibrationFit = null;

        this.renderCalibrationPeakTable();
        this.renderCalibrationPeakChart();
        this.updateCalibrationFitSummary(`${this.calibrationPeaks.length} candidate peak(s) found. Enter known wavelengths in nm, then fit coefficients.`);
        this.log(`Found ${this.calibrationPeaks.length} calibration peak candidate(s)`, 'info');
    }

    refineCalibrationPeak(index) {
        const data = this.currentData;
        const y0 = data[index - 1] ?? data[index];
        const y1 = data[index];
        const y2 = data[index + 1] ?? data[index];
        const denominator = y0 - 2 * y1 + y2;
        let offset = 0;

        if (Math.abs(denominator) > 1e-12) {
            offset = 0.5 * (y0 - y2) / denominator;
            offset = Math.max(-0.5, Math.min(0.5, offset));
        }

        const pixel = index + offset;
        return {
            index,
            pixel,
            intensity: y1
        };
    }

    renderCalibrationPeakChart() {
        if (!Array.isArray(this.currentData) || !this.chart) return;

        this.currentAnalysis = null;
        this.chart.data.datasets[0].data = this.currentData.map((value, index) => ({ x: index, y: value }));
        this.chart.data.datasets[0].hidden = false;
        this.chart.data.datasets[1].data = [];
        this.chart.data.datasets[2].data = [];
        this.chart.data.datasets[3].data = this.calibrationPeaks.map(peak => ({
            x: peak.pixel,
            y: peak.intensity
        }));
        this.chart.data.datasets[3].hidden = false;
        this.chart.data.datasets[4].data = [];
        this.chart.options.scales.x.title.text = 'Sensor Pixel';
        this.setXDomain(0, this.currentData.length - 1);
        this.chart.options.scales.y.suggestedMin = 0;
        this.chart.options.scales.y.max = undefined;
        this.chart.options.scales.y.beginAtZero = true;
        this.chart.update('none');
    }

    renderCalibrationPeakTable() {
        const wrap = document.getElementById('calibrationPeakTableWrap');
        if (!wrap) return;

        if (!this.calibrationPeaks.length) {
            wrap.innerHTML = '';
            return;
        }

        wrap.innerHTML = `
            <table class="calibration-peak-table">
                <thead>
                    <tr>
                        <th>Use</th>
                        <th>Pixel</th>
                        <th>Intensity</th>
                        <th>Known nm</th>
                        <th>Residual</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.calibrationPeaks.map((peak, index) => `
                        <tr>
                            <td><input type="checkbox" data-calibration-use="${index}" ${peak.enabled ? 'checked' : ''}></td>
                            <td>${peak.pixel.toFixed(2)}</td>
                            <td>${Math.round(peak.intensity).toLocaleString()}</td>
                            <td><input type="number" data-calibration-wavelength="${index}" value="${this.escapeHtml(String(peak.wavelength ?? ''))}" step="0.001" placeholder="nm"></td>
                            <td>${Number.isFinite(peak.residual) ? peak.residual.toFixed(4) : '—'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        wrap.querySelectorAll('[data-calibration-wavelength]').forEach(input => {
            input.addEventListener('input', () => {
                const index = Number(input.dataset.calibrationWavelength);
                if (this.calibrationPeaks[index]) this.calibrationPeaks[index].wavelength = input.value;
            });
        });

        wrap.querySelectorAll('[data-calibration-use]').forEach(input => {
            input.addEventListener('change', () => {
                const index = Number(input.dataset.calibrationUse);
                if (this.calibrationPeaks[index]) this.calibrationPeaks[index].enabled = input.checked;
            });
        });
    }

    fitCalibrationPeaks() {
        this.syncCalibrationPeakInputs();

        const order = Math.max(1, Math.min(3, Math.round(this.readNumberInput('calibrationFitOrder', 2))));
        const pairs = this.calibrationPeaks
            .filter(peak => peak.enabled !== false)
            .map(peak => ({
                pixel: Number(peak.pixel),
                wavelength: Number.parseFloat(peak.wavelength)
            }))
            .filter(pair => Number.isFinite(pair.pixel) && Number.isFinite(pair.wavelength));

        if (pairs.length < order + 1) {
            this.log(`Need at least ${order + 1} enabled wavelength matches for this fit order`, 'error');
            this.updateCalibrationFitSummary(`Need at least ${order + 1} enabled wavelength matches for this fit order.`);
            return;
        }

        const coefficients = this.fitPolynomialLeastSquares(pairs, order);
        if (!coefficients) {
            this.log('Calibration fit failed: matrix could not be solved', 'error');
            this.updateCalibrationFitSummary('Fit failed. Check that matched peaks are distinct and wavelengths are numeric.');
            return;
        }

        const fullCoefficients = [0, 0, 0, 0];
        coefficients.forEach((value, index) => {
            fullCoefficients[index] = value;
        });

        const residuals = pairs.map(pair => {
            const fitted = this.evaluatePolynomial(fullCoefficients, pair.pixel);
            return {
                ...pair,
                fitted,
                residual: fitted - pair.wavelength
            };
        });
        const rms = Math.sqrt(residuals.reduce((sum, item) => sum + item.residual * item.residual, 0) / residuals.length);
        const maxAbs = Math.max(...residuals.map(item => Math.abs(item.residual)));

        this.calibrationPeaks = this.calibrationPeaks.map(peak => {
            const match = residuals.find(item => Math.abs(item.pixel - peak.pixel) < 1e-9);
            return {
                ...peak,
                residual: match ? match.residual : null
            };
        });

        ['calibrationC0', 'calibrationC1', 'calibrationC2', 'calibrationC3'].forEach((id, index) => {
            this.setInputValue(id, fullCoefficients[index]);
        });
        const modeSelect = document.getElementById('axisCalibrationMode');
        if (modeSelect) modeSelect.value = 'polynomial';

        this.lastCalibrationFit = { coefficients: fullCoefficients, residuals, rms, maxAbs, order };
        this.renderCalibrationPeakTable();
        this.updateCalibrationFitSummary(`Fit order ${order}: RMS ${rms.toFixed(4)} nm, max residual ${maxAbs.toFixed(4)} nm. Coefficients are staged; click Apply Axis Calibration to use them.`);
        this.log(`Calibration fit complete: RMS ${rms.toFixed(4)} nm`, 'success');
    }

    syncCalibrationPeakInputs() {
        document.querySelectorAll('[data-calibration-wavelength]').forEach(input => {
            const index = Number(input.dataset.calibrationWavelength);
            if (this.calibrationPeaks[index]) this.calibrationPeaks[index].wavelength = input.value;
        });

        document.querySelectorAll('[data-calibration-use]').forEach(input => {
            const index = Number(input.dataset.calibrationUse);
            if (this.calibrationPeaks[index]) this.calibrationPeaks[index].enabled = input.checked;
        });
    }

    fitPolynomialLeastSquares(pairs, order) {
        const size = order + 1;
        const matrix = Array.from({ length: size }, () => Array(size).fill(0));
        const rhs = Array(size).fill(0);
        const pixels = pairs.map(pair => pair.pixel);
        const offset = pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length;
        const scale = Math.max(...pixels.map(pixel => Math.abs(pixel - offset)), 1);

        pairs.forEach(({ pixel, wavelength }) => {
            const x = (pixel - offset) / scale;
            const powers = Array.from({ length: size }, (_, index) => x ** index);
            for (let row = 0; row < size; row += 1) {
                rhs[row] += powers[row] * wavelength;
                for (let col = 0; col < size; col += 1) {
                    matrix[row][col] += powers[row] * powers[col];
                }
            }
        });

        const scaledCoefficients = this.solveLinearSystem(matrix, rhs);
        return scaledCoefficients ? this.convertScaledPolynomialCoefficients(scaledCoefficients, offset, scale) : null;
    }

    convertScaledPolynomialCoefficients(scaledCoefficients, offset, scale) {
        const coefficients = [0, 0, 0, 0];
        const binomial = [
            [1],
            [1, 1],
            [1, 2, 1],
            [1, 3, 3, 1]
        ];

        scaledCoefficients.forEach((coefficient, power) => {
            for (let rawPower = 0; rawPower <= power; rawPower += 1) {
                const factor = binomial[power][rawPower] *
                    ((-offset) ** (power - rawPower)) /
                    (scale ** power);
                coefficients[rawPower] += coefficient * factor;
            }
        });

        return coefficients.slice(0, scaledCoefficients.length);
    }

    solveLinearSystem(matrix, rhs) {
        const n = rhs.length;
        const a = matrix.map((row, index) => [...row, rhs[index]]);

        for (let col = 0; col < n; col += 1) {
            let pivot = col;
            for (let row = col + 1; row < n; row += 1) {
                if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
            }

            if (Math.abs(a[pivot][col]) < 1e-12) return null;
            if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];

            const pivotValue = a[col][col];
            for (let item = col; item <= n; item += 1) {
                a[col][item] /= pivotValue;
            }

            for (let row = 0; row < n; row += 1) {
                if (row === col) continue;
                const factor = a[row][col];
                for (let item = col; item <= n; item += 1) {
                    a[row][item] -= factor * a[col][item];
                }
            }
        }

        return a.map(row => row[n]);
    }

    evaluatePolynomial(coefficients, pixel) {
        return coefficients.reduce((sum, coefficient, index) => sum + coefficient * (pixel ** index), 0);
    }

    updateCalibrationFitSummary(message) {
        const summary = document.getElementById('calibrationFitSummary');
        if (summary) summary.textContent = message;
    }

    syncAxisCalibrationUI() {
        const mode = document.getElementById('axisCalibrationMode')?.value || this.calibrationMode;
        const linearControls = document.getElementById('linearCalibrationControls');
        const polynomialControls = document.getElementById('polynomialCalibrationControls');
        if (linearControls) linearControls.style.display = mode === 'linear' ? 'block' : 'none';
        if (polynomialControls) polynomialControls.style.display = mode === 'polynomial' ? 'block' : 'none';
    }

    getStoredSettingControlIds() {
        return [
            'integrationTime',
            'averageCount',
            'laserWavelength',
            'baudRate',
            'axisCalibrationMode',
            'wavelengthMin',
            'wavelengthMax',
            'calibrationC0',
            'calibrationC1',
            'calibrationC2',
            'calibrationC3',
            'calibrationPeakHeight',
            'calibrationPeakDistance',
            'calibrationFitOrder',
            'calibrationPeakLimit',
            'analysisEnabled',
            'ramanMin',
            'ramanMax',
            'spikeEnabled',
            'spikeThreshold',
            'baselineMethod',
            'snipIterations',
            'lambdaPower',
            'smoothingMethod',
            'smoothingWindow',
            'smoothingOrder',
            'normalizationMethod',
            'peakHeightPercent',
            'peakDistance'
        ];
    }

    saveControlSettings() {
        const settings = {};
        this.getStoredSettingControlIds().forEach(id => {
            const control = document.getElementById(id);
            if (!control) return;
            settings[id] = control.type === 'checkbox' ? control.checked : control.value;
        });

        try {
            localStorage.setItem(this.settingsStorageKey, JSON.stringify(settings));
        } catch (error) {
            this.log(`Could not save settings: ${error.message}`, 'error');
        }
    }

    loadControlSettings() {
        let settings = null;
        try {
            const stored = localStorage.getItem(this.settingsStorageKey);
            settings = stored ? JSON.parse(stored) : null;
        } catch (error) {
            this.log(`Could not load saved settings: ${error.message}`, 'error');
            return;
        }

        if (!settings || typeof settings !== 'object') return;

        this.getStoredSettingControlIds().forEach(id => {
            const control = document.getElementById(id);
            if (!control || settings[id] === undefined) return;
            if (control.type === 'checkbox') {
                control.checked = Boolean(settings[id]);
            } else {
                control.value = String(settings[id]);
            }
        });

        const selectedBaud = parseInt(document.getElementById('baudRate')?.value, 10);
        if (selectedBaud in this.baudRateMap) {
            this.pendingBaudRate = selectedBaud;
        }
    }

    setupCollapsibleSections() {
        document.querySelectorAll('.control-section').forEach(section => {
            section.classList.remove('expanded');
            const toggle = section.querySelector('.section-toggle');
            if (!toggle) return;
            toggle.setAttribute('aria-expanded', 'false');
            toggle.addEventListener('click', () => {
                const expanded = section.classList.toggle('expanded');
                toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            });
        });
    }

    getHelpContent() {
        return {
            csvImportFile: {
                title: 'Import Raw Scan CSV',
                body: [
                    'Loads an existing spectrum without connecting to the device. This is useful for offline Raman processing, comparing workflows, or saving imported data into local storage.',
                    'Supported inputs include simple intensity lists, wavelength/intensity tables, Raman-shift tables, and SpectrumPro-style files with metadata plus Sum/Averaged/Background columns.',
                    'Typical use: import a known reference scan, verify that the wavelength axis is preserved, then adjust Raman processing settings.'
                ]
            },
            integrationTime: {
                title: 'Integration Time',
                body: [
                    'Controls how long the detector collects light for each scan. Longer integration increases signal, but also raises the chance of saturation and drift.',
                    'Typical starting points: 50-200 ms for bright sources, 500-2000 ms for moderate signals, and several seconds for weak Raman signals.',
                    'Use the Query button to read the device value, edit the field, then Set to write it to the spectrometer.'
                ]
            },
            averageCount: {
                title: 'Averaging',
                body: [
                    'Sets how many scans are averaged by the device or acquisition workflow. More averages reduce random noise but make each measurement slower.',
                    'Typical values: 1 for alignment and live feedback, 5-25 for routine spectra, and higher values for weak or noisy signals.',
                    'Use Query to synchronize the UI with the device, then Set after changing the value.'
                ]
            },
            transferMode: {
                title: 'Transfer Mode',
                body: [
                    'Selects how scan data is sent over serial. ASCII is human-readable and easier to debug. Binary is more compact and faster, but depends on exact byte framing.',
                    'Typical use: ASCII for setup, troubleshooting, and compatibility; Binary for faster repeated acquisition once communication is stable.',
                    'The active mode is highlighted when the app knows the device state.'
                ]
            },
            transfermode: {
                title: 'Transfer Mode',
                body: [
                    'Selects how scan data is sent over serial. ASCII is human-readable and easier to debug. Binary is more compact and faster, but depends on exact byte framing.',
                    'Typical use: ASCII for setup, troubleshooting, and compatibility; Binary for faster repeated acquisition once communication is stable.',
                    'The active mode is highlighted when the app knows the device state.'
                ]
            },
            laserWavelength: {
                title: 'Laser Wavelength',
                body: [
                    'The excitation wavelength used for Raman shift conversion. Raman shift is calculated from the calibrated spectrum wavelength and this laser wavelength.',
                    'Typical settings depend on your laser, for example 532 nm, 633 nm, or 785 nm. Enter the actual measured or specified laser wavelength when possible.',
                    'This does not change raw acquisition; it changes the processed Raman x-axis.'
                ]
            },
            axisCalibrationMode: {
                title: 'Sensor Axis',
                body: [
                    'Chooses how detector pixel index maps to the x-axis. Pixel index is safest when no calibration is known. Linear wavelength is an operator assumption. Polynomial wavelength uses fitted calibration coefficients.',
                    'Raman processing requires a wavelength axis, so use a calibrated or imported wavelength column for meaningful Raman shifts.',
                    'Typical workflow: use Pixel index while debugging, then switch to Polynomial wavelength once your calibration coefficients are known.'
                ]
            },
            wavelengthMin: {
                title: 'Linear Range',
                body: [
                    'Defines a simple linear wavelength mapping from the first detector pixel to the last detector pixel.',
                    'This is useful as a rough assumption, but it is not a substitute for a real wavelength calibration. Nonlinear optics and detector alignment can shift peaks.',
                    'Typical range for this setup may be around 400-580 nm or the measured range of your calibrated reference file.'
                ]
            },
            calibrationC0: {
                title: 'Polynomial Coefficients',
                body: [
                    'Defines the wavelength calibration formula: wavelength_nm = c0 + c1*pixel + c2*pixel^2 + c3*pixel^3.',
                    'Use coefficients from a least-squares fit against known spectral lines. This is the preferred calibration mode when you have reference-lamp data.',
                    'Typical values are instrument-specific. c0 is near the wavelength at pixel 0, c1 is the main nm-per-pixel slope, and c2/c3 capture curvature.'
                ]
            },
            baudRate: {
                title: 'Serial Baud Rate',
                body: [
                    'Controls the serial communication speed. The browser port and the spectrometer must use the same baud rate or communication will fail.',
                    'Typical setting is 9600 baud for compatibility. Higher rates can improve transfer speed if the device has already been configured for them.',
                    'Changing this while scanning can interrupt communication, so stop acquisition before applying a new baud rate.'
                ]
            },
            analysisEnabled: {
                title: 'Enable Analysis',
                body: [
                    'Turns the Raman processing pipeline on or off. When enabled, the chart shows processed Raman-shift data instead of only raw intensity versus wavelength or pixel.',
                    'Requires a wavelength axis from calibration or an imported wavelength column.',
                    'Disable it when you want to inspect raw detector counts directly.'
                ]
            },
            ramanMin: {
                title: 'Raman Range',
                body: [
                    'Limits the processed Raman shift range in cm^-1. This focuses baseline correction, normalization, and peak detection on the region of interest.',
                    'Typical broad range is 0-3400 cm^-1. Fingerprint-region work often focuses roughly on 200-1800 cm^-1.',
                    'Narrowing the range can make peak labels and normalization more stable.'
                ]
            },
            spikeEnabled: {
                title: 'Remove Spikes',
                body: [
                    'Detects and interpolates narrow isolated spikes, such as cosmic-ray-like artifacts or serial glitches.',
                    'Use it when a spectrum has single-pixel needle artifacts. Disable it if real peaks are extremely narrow and could be mistaken for spikes.',
                    'The threshold controls how aggressive the detection is; higher values remove fewer spikes.'
                ]
            },
            baselineMethod: {
                title: 'Baseline',
                body: [
                    'Chooses the background/baseline estimation method before peak detection. Baseline removal helps separate Raman peaks from fluorescence or broad background.',
                    'SNIP is usually a good first choice. ALS and arPLS can work better on smooth fluorescence backgrounds but may require lambda tuning.',
                    'Use None when inspecting raw processed behavior or when the input is already baseline-corrected.'
                ]
            },
            snipIterations: {
                title: 'SNIP Iterations',
                body: [
                    'Controls the SNIP baseline window. More iterations remove broader background structure, but can also suppress broad real bands.',
                    'Typical values are around 10-40. Start near 10-15 for narrow peaks and increase if broad fluorescence remains.',
                    'Only affects SNIP baseline mode.'
                ]
            },
            lambdaPower: {
                title: 'ALS/arPLS Lambda',
                body: [
                    'Controls smoothness for ALS and arPLS baseline fitting as a power of ten. Higher values force a smoother baseline.',
                    'Typical values are roughly 10^3 to 10^7 depending on spectrum length and background shape.',
                    'If the baseline follows peaks too closely, increase lambda. If it is too flat to follow background curvature, decrease it.'
                ]
            },
            smoothingMethod: {
                title: 'Smoothing',
                body: [
                    'Chooses optional noise smoothing before peak detection. Smoothing can improve weak peak detection but can also blur narrow peaks.',
                    'Savitzky-Golay is often good for spectra because it preserves peak shape better than a simple moving average.',
                    'Use None when you need to inspect unfiltered data or tune other processing parameters.'
                ]
            },
            smoothingWindow: {
                title: 'Window / SG Order',
                body: [
                    'Window sets how many neighboring points are used for smoothing. SG Order sets the polynomial order for Savitzky-Golay smoothing.',
                    'Typical SG settings are window 7-15 and order 2-3. The window should be odd and wider than random noise, but narrower than peaks you want to preserve.',
                    'For moving average, the order field is ignored.'
                ]
            },
            normalizationMethod: {
                title: 'Normalization',
                body: [
                    'Scales spectra for easier comparison. Max normalization sets the strongest point to 1, area normalization scales total signal, and SNV standardizes mean and variance.',
                    'Use Max = 1 for visual comparison and peak matching. Use Area = 1 when total spectral area should be comparable.',
                    'Use None when absolute intensity matters.'
                ]
            },
            peakHeightPercent: {
                title: 'Peak Detection',
                body: [
                    'Controls automatic peak labeling. Height is a percentage threshold of the processed signal, and distance is the minimum separation between labeled peaks.',
                    'Typical height thresholds are 5-20%. Increase height or distance to reduce clutter; decrease them to find weaker peaks.',
                    'Detected peaks are shown in the chart and can be toggled from the plot legend.'
                ]
            }
        };
    }

    setupHelpTooltips() {
        const help = this.getHelpContent();
        const tooltip = document.createElement('div');
        tooltip.className = 'help-popover';
        tooltip.setAttribute('role', 'tooltip');
        document.body.appendChild(tooltip);

        let hoverTimer = null;
        let hideTimer = null;
        let pinned = false;
        let activeLabel = null;

        const render = item => {
            tooltip.innerHTML = [
                `<h4>${this.escapeHtml(item.title)}</h4>`,
                ...item.body.map(paragraph => `<p>${this.escapeHtml(paragraph)}</p>`)
            ].join('');
        };

        const position = label => {
            const rect = label.getBoundingClientRect();
            const spacing = 12;
            const maxHeight = Math.max(160, window.innerHeight - spacing * 2);
            tooltip.style.maxHeight = `${maxHeight}px`;

            const tooltipWidth = tooltip.offsetWidth;
            const tooltipHeight = Math.min(tooltip.offsetHeight, maxHeight);
            const spaceBelow = window.innerHeight - rect.bottom - spacing;
            const spaceAbove = rect.top - spacing;
            let top;

            if (spaceBelow >= tooltipHeight || spaceBelow >= spaceAbove) {
                top = rect.bottom + spacing;
            } else {
                top = rect.top - tooltipHeight - spacing;
            }

            top = Math.min(window.innerHeight - tooltipHeight - spacing, Math.max(spacing, top));
            const left = Math.min(window.innerWidth - tooltipWidth - spacing, Math.max(spacing, rect.left));
            tooltip.style.top = `${top}px`;
            tooltip.style.left = `${left}px`;
        };

        const show = (label, item, keepOpen = false) => {
            clearTimeout(hideTimer);
            activeLabel = label;
            pinned = keepOpen;
            render(item);
            tooltip.classList.add('open');
            position(label);
        };

        const hide = () => {
            if (pinned) return;
            tooltip.classList.remove('open');
            activeLabel = null;
        };

        const scheduleHide = () => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (tooltip.matches(':hover') || activeLabel?.matches(':hover')) return;
                hide();
            }, 160);
        };

        const labels = [...document.querySelectorAll('.control-group label')];
        labels.forEach(label => {
            const key = label.getAttribute('for') || label.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
            const item = help[key];
            if (!item) return;

            label.classList.add('help-label');
            label.tabIndex = 0;

            label.addEventListener('mouseenter', () => {
                clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => show(label, item), 450);
            });
            label.addEventListener('mouseleave', () => {
                clearTimeout(hoverTimer);
                scheduleHide();
            });
            label.addEventListener('focus', () => show(label, item));
            label.addEventListener('blur', scheduleHide);
            label.addEventListener('click', event => {
                event.preventDefault();
                if (pinned && activeLabel === label) {
                    pinned = false;
                    tooltip.classList.remove('open');
                    return;
                }
                show(label, item, true);
            });
        });

        tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        tooltip.addEventListener('mouseleave', scheduleHide);

        document.addEventListener('click', event => {
            if (!pinned) return;
            if (tooltip.contains(event.target) || event.target === activeLabel) return;
            pinned = false;
            tooltip.classList.remove('open');
        });
        window.addEventListener('resize', () => {
            if (activeLabel && tooltip.classList.contains('open')) position(activeLabel);
        });
    }

    openScanDB() {
        if (!('indexedDB' in window)) {
            return Promise.reject(new Error('IndexedDB is not available in this browser'));
        }

        if (this.scanDbPromise) return this.scanDbPromise;

        this.scanDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.scanDbName, this.scanDbVersion);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this.scanStoreName)) {
                    const store = db.createObjectStore(this.scanStoreName, { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                    store.createIndex('savedAt', 'savedAt', { unique: false });
                    store.createIndex('scanDate', 'metadata.scanDate', { unique: false });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Could not open local scan database'));
        });

        return this.scanDbPromise;
    }

    async putStoredScan(record) {
        const db = await this.openScanDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.scanStoreName, 'readwrite');
            tx.objectStore(this.scanStoreName).put(record);
            tx.oncomplete = () => resolve(record);
            tx.onerror = () => reject(tx.error || new Error('Could not save scan'));
        });
    }

    async getStoredScans() {
        const db = await this.openScanDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.scanStoreName, 'readonly');
            const request = tx.objectStore(this.scanStoreName).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error || new Error('Could not read stored scans'));
        });
    }

    async deleteStoredScanRecord(id) {
        const db = await this.openScanDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.scanStoreName, 'readwrite');
            tx.objectStore(this.scanStoreName).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Could not delete scan'));
        });
    }

    getCurrentScanMetadata() {
        const metadata = this.currentScanMetadata || {};
        const scanDate = metadata['Scan Date'] || metadata.scanDate || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const name = metadata.name || metadata.Name || metadata.fileName || metadata['File Name'] || 'Unsaved scan';
        const savedAt = metadata.savedAt || metadata['Saved At'] || null;
        const integrationTime = Number.parseFloat(metadata['Integration Time'] ?? metadata.integrationTime);
        const averages = Number.parseFloat(metadata['Number of Averages'] ?? metadata.averages);
        const integrationInput = Number.parseFloat(document.getElementById('integrationTime')?.value);
        const averageInput = Number.parseFloat(document.getElementById('averageCount')?.value);

        return {
            name,
            scanDate,
            savedAt,
            integrationTime: Number.isFinite(integrationTime) ? integrationTime : (Number.isFinite(integrationInput) ? integrationInput : null),
            averages: Number.isFinite(averages) ? averages : (Number.isFinite(averageInput) ? averageInput : null),
            source: metadata.source || metadata.Source || 'current'
        };
    }

    formatMetadataLine(metadata = this.getCurrentScanMetadata()) {
        const name = metadata.name || 'Unsaved scan';
        const scanDate = metadata.scanDate || 'unknown date';
        const savedAt = metadata.savedAt || null;
        const integration = Number.isFinite(metadata.integrationTime) ? `${metadata.integrationTime} ms` : 'unknown integration';
        const averages = Number.isFinite(metadata.averages) ? `${metadata.averages} avg` : 'unknown avg';
        return { name, scanDate, savedAt, integration, averages };
    }

    updateScanMetaLine() {
        const line = document.getElementById('scanMetaLine');
        if (!line) return;

        if (!Array.isArray(this.currentData) || this.currentData.length === 0) {
            line.innerHTML = '<span>No scan loaded</span>';
            return;
        }

        const meta = this.formatMetadataLine();
        line.innerHTML = [
            '<div class="scan-meta-row">',
            `<span>Name: <span class="scan-name-value" id="currentScanName" title="Double-click to rename">${this.escapeHtml(meta.name)}</span></span>`,
            `<span>Scan: ${this.escapeHtml(meta.scanDate)}</span>`,
            meta.savedAt ? `<span>Saved: ${this.escapeHtml(meta.savedAt)}</span>` : '',
            '</div>',
            '<div class="scan-meta-row">',
            `<span>Integration: ${this.escapeHtml(meta.integration)}</span>`,
            `<span>Averages: ${this.escapeHtml(meta.averages)}</span>`,
            `<span>Points: ${this.currentData.length}</span>`,
            '</div>'
        ].join('');

        document.getElementById('currentScanName')?.addEventListener('dblclick', () => {
            this.renameCurrentScan();
        });
    }

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    clonePlain(value) {
        return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
    }

    updateStorageUI() {
        const saveBtn = document.getElementById('saveScanBtn');
        if (saveBtn) saveBtn.disabled = !(Array.isArray(this.currentData) && this.currentData.length > 0);
        this.updateScanMetaLine();
    }

    openSaveScanDialog() {
        if (!Array.isArray(this.currentData) || this.currentData.length === 0) {
            this.log('No scan data available to save', 'error');
            return;
        }

        const dialog = document.getElementById('saveScanDialog');
        const input = document.getElementById('saveScanName');
        const meta = this.getCurrentScanMetadata();
        if (input) {
            input.value = `Scan ${meta.scanDate}`;
            setTimeout(() => input.focus(), 0);
        }
        if (dialog) dialog.classList.add('open');
    }

    closeSaveScanDialog() {
        document.getElementById('saveScanDialog')?.classList.remove('open');
    }

    async saveCurrentScanToDB() {
        const input = document.getElementById('saveScanName');
        const name = input?.value?.trim();
        if (!name) {
            this.log('Enter a dataset name before saving', 'error');
            input?.focus();
            return;
        }
        if (!Array.isArray(this.currentData) || this.currentData.length === 0) {
            this.log('No scan data available to save', 'error');
            return;
        }

        const now = new Date().toISOString();
        const record = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            name,
            savedAt: now,
            metadata: {
                ...this.getCurrentScanMetadata(),
                name,
                savedAt: now
            },
            data: [...this.currentData],
            wavelengths: Array.isArray(this.currentWavelengths) ? [...this.currentWavelengths] : null,
            spectrumColumns: this.currentSpectrumColumns ? this.clonePlain(this.currentSpectrumColumns) : null,
            calibrationMode: this.calibrationMode
        };

        try {
            await this.putStoredScan(record);
            this.currentStoredScanId = record.id;
            this.currentScanMetadata = {
                ...record.metadata,
                name: record.name,
                savedAt: record.savedAt
            };
            this.updateStorageUI();
            this.closeSaveScanDialog();
            this.log(`Saved scan "${name}" to local database`, 'success');
            await this.refreshStoredScans();
        } catch (error) {
            this.log(`Save failed: ${error.message}`, 'error');
        }
    }

    async refreshStoredScans() {
        try {
            this.storedScans = await this.getStoredScans();
            this.renderStoredScans();
        } catch (error) {
            this.log(`Could not load stored scans: ${error.message}`, 'error');
        }
    }

    renderStoredScans() {
        const list = document.getElementById('storedScansList');
        if (!list) return;

        const sort = document.getElementById('storedScanSort')?.value || 'timestamp-desc';
        const scans = [...this.storedScans];
        scans.sort((a, b) => {
            if (sort === 'name-asc') return a.name.localeCompare(b.name);
            if (sort === 'name-desc') return b.name.localeCompare(a.name);
            const timeA = Date.parse(a.savedAt || a.metadata?.scanDate || '') || 0;
            const timeB = Date.parse(b.savedAt || b.metadata?.scanDate || '') || 0;
            return sort === 'timestamp-asc' ? timeA - timeB : timeB - timeA;
        });

        if (!scans.length) {
            list.textContent = 'No stored scans yet.';
            return;
        }

        list.innerHTML = scans.map(scan => {
            const meta = this.formatMetadataLine({
                ...(scan.metadata || {}),
                name: scan.name,
                savedAt: scan.savedAt
            });
            return `
                <div class="stored-scan-item">
                    <div class="stored-scan-row">
                        <div>
                            <span class="stored-scan-name" data-rename-scan-id="${this.escapeHtml(scan.id)}" title="Double-click to rename">${this.escapeHtml(scan.name)}</span>
                            <span class="stored-scan-meta">${this.escapeHtml(meta.scanDate)} · ${this.escapeHtml(meta.integration)} · ${this.escapeHtml(meta.averages)}</span>
                        </div>
                        <div class="stored-scan-actions">
                            <button data-load-scan-id="${this.escapeHtml(scan.id)}">Load</button>
                            <button class="delete-scan-btn" data-delete-scan-id="${this.escapeHtml(scan.id)}">Delete</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        list.querySelectorAll('[data-load-scan-id]').forEach(button => {
            button.addEventListener('click', () => this.loadStoredScan(button.dataset.loadScanId));
        });
        list.querySelectorAll('[data-delete-scan-id]').forEach(button => {
            button.addEventListener('click', () => this.deleteStoredScan(button.dataset.deleteScanId));
        });
        list.querySelectorAll('[data-rename-scan-id]').forEach(item => {
            item.addEventListener('dblclick', () => this.renameStoredScan(item.dataset.renameScanId));
        });
    }

    toggleStoredScans(force = null) {
        const popout = document.getElementById('storedScansPopout');
        if (!popout) return;
        const open = force === null ? !popout.classList.contains('open') : Boolean(force);
        popout.classList.toggle('open', open);
        if (open) this.refreshStoredScans();
    }

    loadStoredScan(id) {
        const scan = this.storedScans.find(item => item.id === id);
        if (!scan) return;

        this.currentStoredScanId = scan.id;
        this.currentData = Array.isArray(scan.data) ? [...scan.data] : [];
        this.currentWavelengths = Array.isArray(scan.wavelengths) ? [...scan.wavelengths] : null;
        this.currentSpectrumColumns = scan.spectrumColumns ? this.clonePlain(scan.spectrumColumns) : null;
        this.currentScanMetadata = {
            name: scan.name,
            savedAt: scan.savedAt,
            'Scan Date': scan.metadata?.scanDate,
            'Integration Time': scan.metadata?.integrationTime,
            'Number of Averages': scan.metadata?.averages,
            source: 'localDB'
        };

        if (Number.isFinite(scan.metadata?.integrationTime)) {
            const input = document.getElementById('integrationTime');
            if (input) input.value = String(scan.metadata.integrationTime);
        }
        if (Number.isFinite(scan.metadata?.averages)) {
            const input = document.getElementById('averageCount');
            if (input) input.value = String(scan.metadata.averages);
        }

        this.updateExportUI();
        this.updateStorageUI();
        this.updateChart({ final: true });
        this.updateStatistics();
        this.toggleStoredScans(false);
        this.log(`Loaded stored scan "${scan.name}"`, 'success');
    }

    async renameCurrentScan() {
        if (!Array.isArray(this.currentData) || this.currentData.length === 0) return;

        if (!this.currentStoredScanId) {
            const currentName = this.getCurrentScanMetadata().name;
            const name = window.prompt('Rename current scan display name:', currentName);
            if (!name?.trim()) return;
            this.currentScanMetadata = {
                ...(this.currentScanMetadata || {}),
                name: name.trim()
            };
            this.updateStorageUI();
            return;
        }

        await this.renameStoredScan(this.currentStoredScanId);
    }

    async renameStoredScan(id) {
        const scan = this.storedScans.find(item => item.id === id);
        if (!scan) return;

        const name = window.prompt('Rename stored scan:', scan.name);
        if (!name?.trim() || name.trim() === scan.name) return;

        const renamed = {
            ...scan,
            name: name.trim(),
            metadata: {
                ...(scan.metadata || {}),
                name: name.trim()
            }
        };

        try {
            await this.putStoredScan(renamed);
            this.storedScans = this.storedScans.map(item => item.id === id ? renamed : item);
            if (this.currentStoredScanId === id) {
                this.currentScanMetadata = {
                    ...(this.currentScanMetadata || {}),
                    name: renamed.name
                };
                this.updateStorageUI();
            }
            this.renderStoredScans();
            this.log(`Renamed stored scan to "${renamed.name}"`, 'success');
        } catch (error) {
            this.log(`Rename failed: ${error.message}`, 'error');
        }
    }

    async deleteStoredScan(id) {
        const scan = this.storedScans.find(item => item.id === id);
        if (!scan) return;
        if (!window.confirm(`Delete stored scan "${scan.name}"?`)) return;

        try {
            await this.deleteStoredScanRecord(id);
            if (this.currentStoredScanId === id) {
                this.currentStoredScanId = null;
                this.currentScanMetadata = {
                    ...(this.currentScanMetadata || {}),
                    name: `${scan.name} (deleted from storage)`,
                    savedAt: null
                };
                this.updateStorageUI();
            }
            this.log(`Deleted stored scan "${scan.name}"`, 'info');
            await this.refreshStoredScans();
        } catch (error) {
            this.log(`Delete failed: ${error.message}`, 'error');
        }
    }

    async exportAllScansJSON() {
        try {
            const scans = await this.getStoredScans();
            const payload = {
                exportedAt: new Date().toISOString(),
                app: 'SpectroToy',
                version: 1,
                scanCount: scans.length,
                scans
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const link = document.createElement('a');

            link.href = url;
            link.download = `spectrotoy-scans-${timestamp}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            this.log(`Exported ${scans.length} stored scan(s) as JSON`, 'success');
        } catch (error) {
            this.log(`Export all failed: ${error.message}`, 'error');
        }
    }

    pixelToRamanShift(pixel) {
        const wavelength = this.pixelToWavelengthCalibrated(pixel);
        const laserWavelength = parseFloat(document.getElementById('laserWavelength')?.value) || 532;
        return RamanProcessing.nmToShift(wavelength, laserWavelength);
    }

    async connectDevice() {
        try {
            if (!navigator.serial) {
                this.log('WebSerial API not available in this browser', 'error');
                alert('WebSerial API is not available. Please use Chrome, Edge, or Opera.');
                return;
            }

            if (!this.port) {
                this.port = await navigator.serial.requestPort();
            }

            await this.openCurrentPort();
            
            this.updateConnectionUI(true);
            this.log(`Connected to spectrometer at ${this.baudRate} baud`, 'success');
            
            // Start listening for data
            this.startReadingData();
            
            // Query device status without resetting the device.
            await new Promise(resolve => setTimeout(resolve, 500));
            this.queryStartupSettings();

        } catch (error) {
            this.log(`Connection failed: ${error.message}`, 'error');
            this.isConnected = false;
            this.updateConnectionUI(false);
        }
    }

    async disconnectDevice() {
        try {
            this.isContinuousScanning = false;
            await this.closeCurrentPort();
            
            this.isConnected = false;
            this.updateConnectionUI(false);
            this.log('Disconnected from spectrometer', 'info');
            
        } catch (error) {
            this.log(`Disconnection error: ${error.message}`, 'error');
        }
    }

    updateConnectionUI(connected) {
        const indicator = document.getElementById('statusIndicator');
        const status = document.getElementById('connectionStatus');
        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');
        const scanBtn = document.getElementById('scanBtn');
        const continuousScanBtn = document.getElementById('continuousScanBtn');
        const applyBaudBtn = document.getElementById('applyBaudBtn');

        if (connected) {
            indicator.className = 'status-indicator connected';
            status.textContent = 'Connected';
            connectBtn.disabled = true;
            disconnectBtn.disabled = false;
            scanBtn.disabled = false;
            continuousScanBtn.disabled = false;
            if (applyBaudBtn) applyBaudBtn.disabled = false;
        } else {
            indicator.className = 'status-indicator disconnected';
            status.textContent = 'Disconnected';
            connectBtn.disabled = false;
            disconnectBtn.disabled = true;
            scanBtn.disabled = true;
            continuousScanBtn.disabled = true;
            if (applyBaudBtn) applyBaudBtn.disabled = true;
        }
    }

    updateModeButtons(mode = this.asciiMode ? 'ascii' : 'binary') {
        const asciiBtn = document.getElementById('asciiModeBtn');
        const binaryBtn = document.getElementById('binaryModeBtn');
        if (!asciiBtn || !binaryBtn) return;

        asciiBtn.classList.toggle('mode-active', mode === 'ascii');
        binaryBtn.classList.toggle('mode-active', mode === 'binary');
    }

    async queryStartupSettings() {
        this.queryValue('A');
        await new Promise(resolve => setTimeout(resolve, 120));
        this.queryValue('I');
        await new Promise(resolve => setTimeout(resolve, 120));
        this.queryValue('B');
    }

    updateExportUI() {
        const exportBtn = document.getElementById('exportCubeRamanBtn');
        if (exportBtn) {
            exportBtn.disabled = !(Array.isArray(this.currentData) && this.currentData.length > 0);
        }
        this.updateStorageUI();
    }

    isAnalysisEnabled() {
        return Boolean(document.getElementById('analysisEnabled')?.checked);
    }

    readProcessingOptions() {
        const numberValue = (id, fallback) => {
            const value = parseFloat(document.getElementById(id)?.value);
            return Number.isFinite(value) ? value : fallback;
        };

        return {
            laserNm: numberValue('laserWavelength', 532),
            xMin: numberValue('ramanMin', 0),
            xMax: numberValue('ramanMax', 3400),
            spikeEnabled: document.getElementById('spikeEnabled')?.checked !== false,
            spikeThreshold: numberValue('spikeThreshold', 8.5),
            baselineMethod: document.getElementById('baselineMethod')?.value || 'snip',
            snipIterations: numberValue('snipIterations', 11),
            lambdaPower: numberValue('lambdaPower', 3.2),
            asymmetry: 0.01,
            smoothing: document.getElementById('smoothingMethod')?.value || 'sg',
            smoothingWindow: numberValue('smoothingWindow', 7),
            smoothingOrder: numberValue('smoothingOrder', 3),
            normalization: document.getElementById('normalizationMethod')?.value || 'max',
            peaksEnabled: true,
            peakHeightPercent: numberValue('peakHeightPercent', 12),
            peakDistance: numberValue('peakDistance', 30)
        };
    }

    recomputeAnalysis() {
        if (!Array.isArray(this.currentData) || this.currentData.length === 0) {
            this.currentAnalysis = null;
            this.updateAnalysisSummary();
            return null;
        }

        if (!this.hasWavelengthCalibration()) {
            this.currentAnalysis = null;
            this.updateAnalysisSummary('Raman processing needs a wavelength calibration or imported wavelength column.');
            return null;
        }

        const wavelengths = this.currentData.map((_, index) => this.pixelToWavelengthCalibrated(index));
        this.currentAnalysis = RamanProcessing.processSpectrum(
            wavelengths,
            this.currentData,
            this.readProcessingOptions()
        );
        this.updateAnalysisSummary();
        return this.currentAnalysis;
    }

    updateAnalysisSummary(message = null) {
        const summary = document.getElementById('analysisSummary');
        if (!summary) return;

        if (message) {
            summary.textContent = message;
            return;
        }

        if (!this.currentAnalysis || this.currentAnalysis.processed.length === 0) {
            summary.textContent = 'No processed spectrum yet.';
            return;
        }

        const stats = this.currentAnalysis.stats;
        summary.textContent = [
            `Points in range: ${stats.pointCount}`,
            `Peak intensity: ${stats.peakIntensity.toFixed(4)}`,
            `Peaks detected: ${stats.peakCount}`,
            `Spikes removed: ${this.currentAnalysis.spikeCount}`,
            `Est. SNR: ${stats.snr.toFixed(1)}`,
            `Range: ${stats.rangeMin.toFixed(0)}-${stats.rangeMax.toFixed(0)} cm⁻¹`
        ].join('\n');
    }

    handleProcessingSettingsChanged() {
        this.syncProcessingLabels();
        if (Array.isArray(this.currentData) && this.currentData.length > 0) {
            this.updateChart({ final: true });
            this.updateStatistics();
        }
    }

    syncProcessingLabels() {
        const pairs = [
            ['spikeThreshold', 'spikeThresholdValue', value => Number(value).toFixed(1)],
            ['snipIterations', 'snipIterationsValue', value => String(Math.round(Number(value)))],
            ['lambdaPower', 'lambdaPowerValue', value => Number(value).toFixed(1)]
        ];
        pairs.forEach(([inputId, labelId, format]) => {
            const input = document.getElementById(inputId);
            const label = document.getElementById(labelId);
            if (input && label) label.textContent = format(input.value);
        });
    }

    async openCurrentPort() {
        await this.port.open({
            baudRate: this.pendingBaudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none'
        });

        this.baudRate = this.pendingBaudRate;
        this.isConnected = true;
        this.reader = this.port.readable.getReader();
        this.writer = this.port.writable.getWriter();
    }

    async closeCurrentPort() {
        this.isConnected = false;
        this.resetBinaryScanState();

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (error) {
                // Ignore cancellation races during disconnect/reopen.
            }
            this.reader.releaseLock();
            this.reader = null;
        }

        if (this.writer) {
            try {
                await this.writer.close();
            } catch (error) {
                // Ignore writer shutdown races during disconnect/reopen.
            }
            this.writer.releaseLock();
            this.writer = null;
        }

        if (this.port?.readable || this.port?.writable) {
            await this.port.close();
        }
    }

    async writeCommand(command) {
        if (!this.writer || !this.isConnected) {
            this.log('Device not connected', 'error');
            return;
        }

        try {
            const data = new TextEncoder().encode(command + '\r\n');
            await this.writer.write(data);
            this.log(`Sent: ${command}`, 'command');
        } catch (error) {
            this.log(`Write error: ${error.message}`, 'error');
        }
    }

    async startReadingData() {
        try {
            while (this.isConnected && this.reader) {
                const { value, done } = await this.reader.read();
                
                if (done) {
                    break;
                }

                const bytes = new Uint8Array(value);

                if (this.asciiMode) {
                    this.textBuffer += new TextDecoder().decode(bytes);
                    while (this.textBuffer.includes('\r\n') || this.textBuffer.includes('\n')) {
                        let lineEnd = this.textBuffer.indexOf('\r\n');
                        if (lineEnd === -1) {
                            lineEnd = this.textBuffer.indexOf('\n');
                        }
                        if (lineEnd === -1) break;

                        const line = this.textBuffer.substring(0, lineEnd).trim();
                        this.textBuffer = this.textBuffer.substring(lineEnd + (this.textBuffer[lineEnd] === '\r' ? 2 : 1));
                        if (line) {
                            this.processResponse(line);
                        }
                    }
                } else {
                    if (this.awaitingBinaryScan) {
                        this.lastBinaryByteTime = Date.now();
                        const buffer = new Uint8Array(this.binaryBuffer.length + bytes.length);
                        buffer.set(this.binaryBuffer);
                        buffer.set(bytes, this.binaryBuffer.length);
                        this.binaryBuffer = buffer;
                        this.tryParseBinaryBuffer();
                    } else {
                        this.handleIdleBinaryBytes(bytes);
                    }
                }
            }
        } catch (error) {
            if (this.isConnected) {
                this.log(`Read error: ${error.message}`, 'error');
            }
        }
    }

    resetBinaryScanState() {
        this.awaitingBinaryScan = false;
        this.binaryBuffer = new Uint8Array();
        this.scanStartTime = 0;
        this.lastBinaryByteTime = 0;
        this.lastPreviewRenderTime = 0;
    }

    getScanTimeoutMs() {
        const integrationTime = parseInt(document.getElementById('integrationTime')?.value, 10) || 100;
        return Math.max(1200, integrationTime * 4 + 1200);
    }

    recoverFromScanTimeout(reason) {
        this.consecutiveScanTimeouts += 1;
        this.log(`Binary scan recovery: ${reason}`, 'error');
        this.resetBinaryScanState();
        this.textBuffer = '';

        if (this.consecutiveScanTimeouts >= 3 && this.isContinuousScanning) {
            this.isContinuousScanning = false;
            document.getElementById('continuousScanBtn').textContent = 'Start Continuous';
            this.log('Continuous scan stopped after repeated recovery events', 'error');
        }
    }

    processResponse(line) {
        if (this.handleDeviceSettingResponse(line)) {
            this.log(`Response: ${line}`, 'response');
            return;
        }

        // Check if this is spectral data (space or tab separated numbers)
        if (line.match(/^[\d\s\t]+$/)) {
            const values = line.trim().split(/[\s\t]+/).map(v => {
                const parsed = parseInt(v, 10);
                return isNaN(parsed) ? null : parsed;
            }).filter(v => v !== null);

            if (values.length > 0) {
                this.log(`Response: ${values.length} pixel values received`, 'response');
                this.parseASCIIData(values);
            }
        } else {
            if (line.trim()) {
                this.log(`Response: ${line}`, 'response');
            }
        }
    }

    handleDeviceSettingResponse(line) {
        const trimmed = line.trim();
        if (!trimmed) return false;

        const numericValue = Number.parseFloat(trimmed.match(/[-+]?\d*\.?\d+/)?.[0] ?? '');
        const upper = trimmed.toUpperCase();
        const explicitParam = upper.match(/(?:^|\?|\b)([AIB])\s*(?:=|:|\s)\s*([-+]?\d*\.?\d+)/);
        let param = explicitParam?.[1] || this.pendingQueryParam;
        const value = explicitParam ? Number.parseFloat(explicitParam[2]) : numericValue;

        if (!explicitParam && Number.isFinite(value)) {
            if (upper.includes('AVERAGE')) param = 'A';
            if (upper.includes('INTEGRATION')) param = 'I';
        }

        if (upper.includes('ASCII')) {
            this.asciiMode = true;
            this.updateModeButtons('ascii');
            this.pendingQueryParam = null;
            return true;
        }

        if (upper.includes('BINARY')) {
            this.asciiMode = false;
            this.updateModeButtons('binary');
            this.pendingQueryParam = null;
            return true;
        }

        if (param === 'A' && Number.isFinite(value)) {
            const input = document.getElementById('averageCount');
            if (input) input.value = String(Math.round(value));
            this.saveControlSettings();
            this.pendingQueryParam = null;
            return true;
        }

        if (param === 'I' && Number.isFinite(value)) {
            const input = document.getElementById('integrationTime');
            if (input) input.value = String(Math.round(value));
            this.saveControlSettings();
            this.pendingQueryParam = null;
            return true;
        }

        if (param === 'B' && (value === 0 || value === 1)) {
            this.asciiMode = value === 0;
            this.updateModeButtons(this.asciiMode ? 'ascii' : 'binary');
            this.pendingQueryParam = null;
            return true;
        }

        return false;
    }

    parseDelimitedLine(line) {
        const values = [];
        let current = '';
        let quoted = false;

        for (let i = 0; i < line.length; i += 1) {
            const char = line[i];
            if (char === '"') {
                if (quoted && line[i + 1] === '"') {
                    current += '"';
                    i += 1;
                } else {
                    quoted = !quoted;
                }
            } else if ((char === ',' || char === ';' || char === '\t') && !quoted) {
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }

        values.push(current.trim());
        return values;
    }

    parseCsvText(text) {
        const rows = text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'))
            .map(line => this.parseDelimitedLine(line));

        if (!rows.length) {
            throw new Error('CSV file is empty');
        }

        const numericRows = [];
        const metadata = {};
        let header = null;
        let tableStarted = false;

        const normalizeHeader = row => row.map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
        const rowLooksLikeHeader = row => {
            const names = normalizeHeader(row);
            return names.some(name => (
                name.includes('pixel') ||
                name.includes('wavelength') ||
                name.includes('spectrum') ||
                name.includes('intensity') ||
                name.includes('counts') ||
                name.includes('raman_shift')
            ));
        };

        rows.forEach(row => {
            const numeric = row.map(value => Number.parseFloat(String(value).replace(',', '.')));
            const numericCount = numeric.filter(Number.isFinite).length;

            if (!tableStarted && rowLooksLikeHeader(row)) {
                header = normalizeHeader(row);
                tableStarted = true;
                return;
            }

            if (numericCount >= Math.min(2, row.length)) {
                tableStarted = true;
                numericRows.push(numeric);
            } else if (!tableStarted && row.length >= 2) {
                const key = row[0].replace(/:$/, '').trim();
                const value = row.slice(1).join(',').trim();
                if (key && value) metadata[key] = value;
            }
        });

        if (!numericRows.length) {
            throw new Error('No numeric scan rows found in CSV');
        }

        const columnCount = Math.max(...numericRows.map(row => row.length));
        let wavelengthColumn = -1;
        let ramanShiftColumn = -1;
        let intensityColumn = -1;
        let pixelColumn = -1;
        let sumColumn = -1;
        let averagedColumn = -1;
        let backgroundColumn = -1;

        if (header) {
            pixelColumn = header.findIndex(name => name.includes('pixel'));
            wavelengthColumn = header.findIndex(name => (
                name.includes('wavelength') || name === 'wl' || name.includes('lambda')
            ));
            ramanShiftColumn = header.findIndex(name => (
                name.includes('raman_shift') || name.includes('shift_cm') || name === 'shift'
            ));
            sumColumn = header.findIndex(name => name.includes('sum') && name.includes('spectrum'));
            averagedColumn = header.findIndex(name => (
                name.includes('averaged_spectrum') || name.includes('average_spectrum') || name === 'averaged'
            ));
            backgroundColumn = header.findIndex(name => name.includes('background') && name.includes('spectrum'));
            const preferredIntensityNames = [
                'averaged_spectrum',
                'average_spectrum',
                'averaged',
                'raw_intensity',
                'raw',
                'intensity',
                'counts',
                'value'
            ];
            intensityColumn = preferredIntensityNames
                .map(name => header.findIndex(column => column === name || column.includes(name)))
                .find(index => index >= 0) ?? -1;

            if (intensityColumn === wavelengthColumn) {
                intensityColumn = -1;
            }
            if (intensityColumn === ramanShiftColumn) {
                intensityColumn = -1;
            }
        }

        if (intensityColumn < 0) {
            const stats = Array.from({ length: columnCount }, (_, column) => {
                const values = numericRows.map(row => row[column]).filter(Number.isFinite);
                return {
                    column,
                    count: values.length,
                    min: values.length ? Math.min(...values) : 0,
                    max: values.length ? Math.max(...values) : 0,
                    range: values.length ? Math.max(...values) - Math.min(...values) : 0
                };
            });

            const candidates = stats.filter(stat => stat.count >= numericRows.length * 0.8);
            if (wavelengthColumn >= 0) {
                intensityColumn = candidates
                    .filter(stat => stat.column !== wavelengthColumn)
                    .sort((a, b) => b.range - a.range)[0]?.column ?? -1;
            } else if (columnCount >= 2) {
                const first = stats[0];
                if (first.count && first.min >= 150 && first.max <= 1200 && first.range > 20) {
                    wavelengthColumn = 0;
                    intensityColumn = candidates
                        .filter(stat => stat.column !== 0)
                        .sort((a, b) => b.range - a.range)[0]?.column ?? 1;
                } else {
                    intensityColumn = candidates.sort((a, b) => b.range - a.range)[0]?.column ?? 0;
                }
            } else {
                intensityColumn = 0;
            }
        }

        if (intensityColumn < 0) {
            throw new Error('Could not identify an intensity column');
        }

        const laserWavelength = parseFloat(document.getElementById('laserWavelength')?.value) || 532;
        const intensities = [];
        let wavelengths = [];
        const spectrumColumns = {
            pixels: [],
            wavelengths: [],
            sum: [],
            averaged: [],
            background: []
        };
        numericRows.forEach(row => {
            const intensity = row[intensityColumn];
            if (!Number.isFinite(intensity)) return;

            let wavelength = NaN;
            if (wavelengthColumn >= 0 && wavelengthColumn !== intensityColumn) {
                wavelength = row[wavelengthColumn];
            } else if (ramanShiftColumn >= 0 && ramanShiftColumn !== intensityColumn) {
                const shift = row[ramanShiftColumn];
                if (Number.isFinite(shift)) {
                    wavelength = 1e7 / ((1e7 / laserWavelength) - shift);
                }
            }

            intensities.push(intensity);
            if (pixelColumn >= 0 && Number.isFinite(row[pixelColumn])) spectrumColumns.pixels.push(row[pixelColumn]);
            if (sumColumn >= 0 && Number.isFinite(row[sumColumn])) spectrumColumns.sum.push(row[sumColumn]);
            if (averagedColumn >= 0 && Number.isFinite(row[averagedColumn])) spectrumColumns.averaged.push(row[averagedColumn]);
            if (backgroundColumn >= 0 && Number.isFinite(row[backgroundColumn])) spectrumColumns.background.push(row[backgroundColumn]);
            if (Number.isFinite(wavelength)) {
                wavelengths.push(wavelength);
                spectrumColumns.wavelengths.push(wavelength);
            }
        });

        if (!intensities.length) {
            throw new Error('Intensity column contains no numeric data');
        }

        return {
            intensities,
            wavelengths: wavelengths.length === intensities.length ? wavelengths : [],
            spectrumColumns,
            metadata,
            pixelColumn,
            sumColumn,
            averagedColumn,
            backgroundColumn,
            intensityColumn,
            wavelengthColumn,
            ramanShiftColumn,
            header
        };
    }

    async importScanCSV(file) {
        if (!file) return;

        try {
            const text = await file.text();
            const parsed = this.parseCsvText(text);
            parsed.metadata.name = file.name;
            parsed.metadata.source = 'csv';
            parsed.metadata.fileName = file.name;
            const importedIntegration = Number.parseFloat(parsed.metadata['Integration Time']);
            const importedAverages = Number.parseFloat(parsed.metadata['Number of Averages']);
            if (Number.isFinite(importedIntegration)) {
                const integrationInput = document.getElementById('integrationTime');
                if (integrationInput) integrationInput.value = String(importedIntegration);
            }
            if (Number.isFinite(importedAverages)) {
                const averageInput = document.getElementById('averageCount');
                if (averageInput) averageInput.value = String(importedAverages);
            }

            if (parsed.wavelengths.length >= this.pixelCount * 0.5) {
                const minWavelength = Math.min(...parsed.wavelengths);
                const maxWavelength = Math.max(...parsed.wavelengths);
                if (Number.isFinite(minWavelength) && Number.isFinite(maxWavelength) && maxWavelength > minWavelength) {
                    this.log(`Imported wavelength range ${minWavelength.toFixed(2)}-${maxWavelength.toFixed(2)} nm`, 'info');
                }
            }

            this.parseASCIIData(parsed.intensities, parsed.wavelengths, {
                spectrumColumns: parsed.spectrumColumns,
                metadata: parsed.metadata
            });
            this.saveControlSettings();
            this.log(`Imported ${file.name} (${parsed.intensities.length} numeric samples)`, 'success');
        } catch (error) {
            this.log(`CSV import failed: ${error.message}`, 'error');
            alert(`CSV import failed: ${error.message}`);
        } finally {
            const input = document.getElementById('csvImportFile');
            if (input) input.value = '';
        }
    }

    extractAsciiLines(bytes) {
        let offset = 0;
        const decoder = new TextDecoder();
        while (offset < bytes.length) {
            const chunk = bytes.slice(offset);
            const text = decoder.decode(chunk);
            const rn = text.indexOf('\r\n');
            const n = text.indexOf('\n');
            let lineEnd = -1;
            let delimLen = 1;
            if (rn >= 0 && (n === -1 || rn < n)) {
                lineEnd = rn;
                delimLen = 2;
            } else if (n >= 0) {
                lineEnd = n;
            }
            if (lineEnd === -1) break;
            const line = text.substring(0, lineEnd).trim();
            if (line) {
                this.processResponse(line);
            }
            offset += lineEnd + delimLen;
        }
        return bytes.slice(offset);
    }

    handleIdleBinaryBytes(bytes) {
        this.textBuffer += new TextDecoder().decode(bytes);

        while (this.textBuffer.includes('\r\n') || this.textBuffer.includes('\n')) {
            let lineEnd = this.textBuffer.indexOf('\r\n');
            if (lineEnd === -1) {
                lineEnd = this.textBuffer.indexOf('\n');
            }
            if (lineEnd === -1) break;

            const line = this.textBuffer.substring(0, lineEnd).trim();
            this.textBuffer = this.textBuffer.substring(lineEnd + (this.textBuffer[lineEnd] === '\r' ? 2 : 1));
            if (line) {
                this.processResponse(line);
            }
        }

        // Binary scans may be followed by a few non-line-terminated tail bytes.
        // They are not a new scan and must not be fed back into the binary parser.
        if (this.textBuffer.length > 64) {
            this.log(`Discarded ${this.textBuffer.length} idle byte(s) after binary scan`, 'info');
            this.textBuffer = '';
        }
    }

    parseASCIIData(values, wavelengths = null, options = {}) {
        // Handle both array input and string input for flexibility
        let data = Array.isArray(values) ? values.map(Number) : values.trim().split(/\s+/).map(v => parseFloat(v));
        data = data.filter(v => !isNaN(v));
        let wavelengthData = Array.isArray(wavelengths) ? wavelengths.map(Number).filter(v => !isNaN(v)) : null;
        const sourceColumns = options.spectrumColumns || null;
        
        this.log(`Parsed ${data.length} values (expected ${this.pixelCount})`, 'info');
        
        // Accept data within 5% of expected pixel count
        // Some devices might have slight variations
        if (data.length >= this.pixelCount * 0.95) {
            // Truncate or pad to exact pixel count
            if (data.length > this.pixelCount) {
                data = data.slice(0, this.pixelCount);
                if (wavelengthData) wavelengthData = wavelengthData.slice(0, this.pixelCount);
            } else if (data.length < this.pixelCount) {
                // Pad with last value if short
                const lastVal = data[data.length - 1] || 0;
                const lastWavelength = wavelengthData?.[wavelengthData.length - 1];
                while (data.length < this.pixelCount) {
                    data.push(lastVal);
                    if (wavelengthData && Number.isFinite(lastWavelength)) {
                        wavelengthData.push(lastWavelength);
                    }
                }
            }
            
            this.currentData = data;
            this.currentWavelengths = wavelengthData && wavelengthData.length === data.length ? wavelengthData : null;
            this.currentSpectrumColumns = sourceColumns ? {
                pixels: sourceColumns.pixels?.length === data.length ? sourceColumns.pixels : null,
                wavelengths: sourceColumns.wavelengths?.length === data.length ? sourceColumns.wavelengths : this.currentWavelengths,
                sum: sourceColumns.sum?.length === data.length ? sourceColumns.sum : null,
                averaged: sourceColumns.averaged?.length === data.length ? sourceColumns.averaged : null,
                background: sourceColumns.background?.length === data.length ? sourceColumns.background : null
            } : null;
            this.currentScanMetadata = options.metadata || {
                'Scan Date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                'Integration Time': document.getElementById('integrationTime')?.value || '',
                'Number of Averages': document.getElementById('averageCount')?.value || '',
                source: 'device'
            };
            this.currentStoredScanId = null;
            this.log('Chart data updated successfully', 'success');
            this.updateExportUI();
            this.updateChart({ final: true });
            this.updateStatistics();
        } else {
            this.log(`Data incomplete: received ${data.length} but need at least ${Math.floor(this.pixelCount * 0.95)}`, 'error');
        }
    }

    tryParseBinaryBuffer() {
        const result = this.parseBinaryData(this.binaryBuffer);
        if (result.complete) {
            const trailingBytes = this.binaryBuffer.slice(result.consumedBytes);
            this.currentData = result.values;
            this.currentSpectrumColumns = null;
            this.currentScanMetadata = {
                'Scan Date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                'Integration Time': document.getElementById('integrationTime')?.value || '',
                'Number of Averages': document.getElementById('averageCount')?.value || '',
                source: 'device'
            };
            this.currentStoredScanId = null;
            this.resetBinaryScanState();
            this.consecutiveScanTimeouts = 0;
            this.log('Binary scan completed', 'success');
            this.updateExportUI();
            this.updateChart({ final: true });
            this.updateStatistics();
            if (trailingBytes.length > 0) {
                this.handleIdleBinaryBytes(trailingBytes);
            }
        } else if (result.values.length > 32) {
            const now = Date.now();
            if (now - this.lastPreviewRenderTime >= 60) {
                this.lastPreviewRenderTime = now;
                this.updateChart({
                    data: this.buildProgressivePreviewData(result.values),
                    final: false,
                    hotIndex: result.values.length
                });
            }
        } else if (this.binaryBuffer.length > this.pixelCount * 4) {
            this.recoverFromScanTimeout(`discarded oversized binary buffer (${this.binaryBuffer.length} bytes)`);
        }
    }

    buildProgressivePreviewData(partialValues) {
        const baseline = Array.isArray(this.currentData) && this.currentData.length === this.pixelCount
            ? [...this.currentData]
            : new Array(this.pixelCount).fill(0);

        for (let i = 0; i < partialValues.length && i < baseline.length; i += 1) {
            baseline[i] = partialValues[i];
        }

        return baseline;
    }

    parseBinaryData(buffer) {
        const values = [];
        let currentValue = 0;
        let i = 0;
        let maxValue = 0;

        while (i < buffer.length && values.length < this.pixelCount) {
            const byte = buffer[i];

            if (byte === 0x80) {
                if (i + 2 >= buffer.length) break; // wait for more bytes
                const high = buffer[i + 1];
                const low = buffer[i + 2];
                currentValue = (high << 8) | low;
                i += 3;
            } else {
                const diff = byte > 127 ? byte - 256 : byte;
                currentValue += diff;
                i += 1;
            }

            const clampedValue = Math.max(0, Math.min(65535, currentValue));
            values.push(clampedValue);
            maxValue = Math.max(maxValue, clampedValue);
        }

        const complete = values.length === this.pixelCount;
        if (complete) {
            this.log(`Parsed ${values.length} pixel values from binary scan (max: ${maxValue})`, 'info');
        } else {
            this.log(`Binary data buffered: ${buffer.length} bytes, ${values.length} pixels decoded so far`, 'info');
        }

        return {
            complete,
            values,
            consumedBytes: complete ? i : 0
        };
    }

    updateChart(options = {}) {
        const { data = this.currentData, final = true, hotIndex = null } = options;

        if (!data || data.length === 0) {
            this.log('No data to display in chart', 'error');
            return;
        }

        try {
            if (this.isAnalysisEnabled() && final && data === this.currentData) {
                const analysis = this.recomputeAnalysis();
                this.updateProcessedChart(analysis);
            } else {
                this.currentAnalysis = null;
                this.updateAnalysisSummary();
                this.updateRawChart(data, hotIndex);
            }

            this.chart.update('none');
            if (final) {
                this.log(`Chart rendered with ${data.length} points`, 'success');
            }
        } catch (error) {
            this.log(`Chart update error: ${error.message}`, 'error');
        }
    }

    updateRawChart(data, hotIndex) {
        const chartData = data.map((value, index) => ({
            x: this.getXAxisValue(index),
            y: value
        }));

        this.chart.data.datasets[0].data = chartData;
        this.chart.data.datasets[0].hidden = false;
        this.chart.data.datasets[1].data = [];
        this.chart.data.datasets[2].data = [];
        this.chart.data.datasets[3].data = [];
        this.chart.data.datasets[4].data = this.buildCursorLine(data, hotIndex, false);

        this.chart.options.scales.x.title.text = this.getXAxisLabel();
        this.setXDomain(this.getXAxisValue(0), this.getXAxisValue(this.pixelCount - 1));
        this.chart.options.scales.y.suggestedMin = 0;
        this.chart.options.scales.y.max = undefined;
        this.chart.options.scales.y.beginAtZero = true;
    }

    updateProcessedChart(analysis) {
        if (!analysis || analysis.processed.length === 0) {
            this.updateRawChart(this.currentData, null);
            return;
        }

        const rawNorm = RamanProcessing.normalize01(analysis.raw);
        const baselineNorm = RamanProcessing.normalize01(analysis.baseline);

        this.chart.data.datasets[0].data = analysis.x.map((x, index) => ({
            x,
            y: rawNorm[index]
        }));

        this.chart.data.datasets[1].data = analysis.x.map((x, index) => ({
            x,
            y: analysis.processed[index]
        }));
        this.chart.data.datasets[1].hidden = false;

        this.chart.data.datasets[2].data = analysis.x.map((x, index) => ({
            x,
            y: baselineNorm[index]
        }));

        this.chart.data.datasets[3].data = analysis.peaks.map(peak => ({
            x: peak.x,
            y: peak.y
        }));
        this.chart.data.datasets[3].hidden = false;
        this.chart.data.datasets[4].data = [];

        this.chart.options.scales.x.title.text = 'Raman Shift (cm⁻¹)';
        this.setXDomain(analysis.stats.rangeMin, analysis.stats.rangeMax);
        this.chart.options.scales.y.suggestedMin = undefined;
        this.chart.options.scales.y.max = undefined;
        this.chart.options.scales.y.beginAtZero = false;
    }

    buildCursorLine(data, hotIndex, useRamanShift = false) {
        if (hotIndex === null || hotIndex < 0 || hotIndex >= this.pixelCount) {
            return [];
        }

        const yMax = Math.max(1, ...data);
        const pixel = Math.min(hotIndex, this.pixelCount - 1);
        const x = useRamanShift ? this.pixelToRamanShift(pixel) : this.getXAxisValue(pixel);
        return [
            { x, y: 0 },
            { x, y: yMax }
        ];
    }

    updateStatistics() {
        if (!this.currentData) return;

        if (this.isAnalysisEnabled() && this.currentAnalysis?.processed?.length) {
            const analysis = this.currentAnalysis;
            const peak = analysis.peaks.length
                ? analysis.peaks.reduce((best, item) => (item.y > best.y ? item : best), analysis.peaks[0])
                : analysis.processed.reduce((best, value, index) => (
                    value > best.y ? { x: analysis.x[index], y: value } : best
                ), { x: analysis.x[0], y: analysis.processed[0] });

            const sorted = [...analysis.processed].sort((a, b) => a - b);
            const q1Index = Math.floor(sorted.length * 0.25);
            const noiseFloor = sorted[q1Index] || 0;

            const peakLabel = document.getElementById('peakAxisLabel');
            if (peakLabel) peakLabel.textContent = 'Peak Raman Shift';
            document.getElementById('peakWavelength').textContent = peak.x.toFixed(1);
            document.querySelector('#peakWavelength + .unit').textContent = 'cm⁻¹';
            document.getElementById('peakIntensity').textContent = peak.y.toFixed(4);
            document.getElementById('noiseFloor').textContent = noiseFloor.toFixed(4);
            return;
        }

        const data = this.currentData;
        
        // Find peak
        const maxValue = Math.max(...data);
        const maxIndex = data.indexOf(maxValue);
        const peakX = this.getXAxisValue(maxIndex);

        // Calculate noise floor (lower quartile)
        const sorted = [...data].sort((a, b) => a - b);
        const q1Index = Math.floor(sorted.length * 0.25);
        const noiseFloor = sorted[q1Index];

        // Update UI
        const peakLabel = document.getElementById('peakAxisLabel');
        if (peakLabel) peakLabel.textContent = this.hasWavelengthCalibration() ? 'Peak Wavelength' : 'Peak Pixel';
        document.getElementById('peakWavelength').textContent = peakX.toFixed(this.hasWavelengthCalibration() ? 1 : 0);
        document.querySelector('#peakWavelength + .unit').textContent = this.getXAxisUnit();
        document.getElementById('peakIntensity').textContent = maxValue.toLocaleString();
        document.getElementById('noiseFloor').textContent = noiseFloor.toLocaleString();
    }

    async performScan() {
        this.sendCommand('S');
    }

    async toggleContinuousScan() {
        const btn = document.getElementById('continuousScanBtn');
        
        if (this.isContinuousScanning) {
            this.isContinuousScanning = false;
            btn.textContent = 'Start Continuous';
            this.log('Continuous scan stopped', 'info');
        } else {
            this.isContinuousScanning = true;
            btn.textContent = 'Stop Continuous';
            this.log('Continuous scan started', 'info');
            this.continuousScanLoop();
        }
    }

    async continuousScanLoop() {
        while (this.isContinuousScanning && this.isConnected) {
            if (this.awaitingBinaryScan) {
                const now = Date.now();
                const timeoutMs = this.getScanTimeoutMs();
                const lastActivity = Math.max(this.lastBinaryByteTime, this.scanStartTime);
                if (lastActivity && now - lastActivity > timeoutMs) {
                    this.recoverFromScanTimeout(`scan timed out after ${now - this.scanStartTime} ms`);
                }
            }

            if (!this.awaitingBinaryScan) {
                this.sendCommand('S');
            }

            const integrationTime = parseInt(document.getElementById('integrationTime').value, 10) || 100;
            const pollingDelay = this.asciiMode ? 250 : Math.max(80, Math.min(400, Math.round(integrationTime * 0.75)));
            await new Promise(resolve => setTimeout(resolve, pollingDelay));
        }
    }

    async sendCommand(command) {
        if (command === 'a') {
            this.asciiMode = true;
            this.awaitingBinaryScan = false;
            this.binaryBuffer = new Uint8Array();
            this.updateModeButtons('ascii');
            this.log('Switched to ASCII mode', 'info');
        } else if (command === 'b') {
            this.asciiMode = false;
            this.updateModeButtons('binary');
            this.log('Switched to Binary mode', 'info');
        } else if (command === 'S' && !this.asciiMode) {
            this.awaitingBinaryScan = true;
            this.binaryBuffer = new Uint8Array();
            this.scanStartTime = Date.now();
            this.lastBinaryByteTime = this.scanStartTime;
            this.lastScanCommandTime = this.scanStartTime;
            this.log('Awaiting binary scan data...', 'info');
        }
        this.writeCommand(command);
    }

    async queryValue(param) {
        this.pendingQueryParam = String(param).toUpperCase();
        this.writeCommand(`?${param}`);
    }

    async setSetting(param) {
        let value;
        
        if (param === 'I') {
            value = document.getElementById('integrationTime').value;
        } else if (param === 'A') {
            value = document.getElementById('averageCount').value;
        } else {
            return;
        }

        this.writeCommand(`${param}${value}`);
    }

    formatCsvValue(value) {
        if (value === null || value === undefined) return '';
        const text = String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    formatCsvNumber(value, decimals = null) {
        if (!Number.isFinite(value)) return '';
        if (decimals !== null) return Number(value).toFixed(decimals);
        return String(Number(value));
    }

    buildSpectrumProCSV() {
        if (!Array.isArray(this.currentData) || this.currentData.length === 0) {
            throw new Error('No spectrum data available to export');
        }

        const integrationTime = parseInt(document.getElementById('integrationTime')?.value, 10);
        const averageCount = parseInt(document.getElementById('averageCount')?.value, 10);
        const metadata = this.currentScanMetadata || {};
        const scanDate = metadata['Scan Date'] || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const integrationText = Number.isFinite(integrationTime)
            ? integrationTime
            : (metadata['Integration Time'] || '');
        const averageText = Number.isFinite(averageCount)
            ? averageCount
            : (metadata['Number of Averages'] || '');
        const averages = Number.isFinite(averageCount) && averageCount > 0 ? averageCount : 1;

        const lines = [
            `Scan Date:,${this.formatCsvValue(scanDate)}`,
            `Integration Time:,${this.formatCsvValue(integrationText)}`,
            `Number of Averages:,${this.formatCsvValue(averageText)}`,
            '',
            'Pixel Number,Wavelength (nm),Sum Spectrum,Averaged Spectrum,Background Spectrum'
        ];

        this.currentData.forEach((intensity, pixel) => {
            const columns = this.currentSpectrumColumns || {};
            const sourcePixel = columns.pixels?.[pixel];
            const wavelength = columns.wavelengths?.[pixel] ?? (
                this.hasWavelengthCalibration() ? this.pixelToWavelengthCalibrated(pixel) : NaN
            );
            const averaged = columns.averaged?.[pixel] ?? intensity;
            const sum = columns.sum?.[pixel] ?? (averaged * averages);
            const background = columns.background?.[pixel] ?? 0;
            lines.push([
                this.formatCsvNumber(Number.isFinite(sourcePixel) ? sourcePixel : pixel),
                this.formatCsvNumber(wavelength),
                this.formatCsvNumber(sum),
                this.formatCsvNumber(averaged),
                this.formatCsvNumber(background)
            ].join(','));
        });

        return lines.join('\r\n');
    }

    buildCubeRamanCSV() {
        return this.buildSpectrumProCSV();
    }

    exportCubeRamanCSV() {
        try {
            const csv = this.buildSpectrumProCSV();
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const link = document.createElement('a');

            link.href = url;
            link.download = `spectrotoy-spectrumpro-${timestamp}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            this.log(`Exported SpectrumPro CSV with ${this.currentData.length} rows`, 'success');
        } catch (error) {
            this.log(`Export failed: ${error.message}`, 'error');
        }
    }

    async applyBaudRate() {
        const baudSelect = document.getElementById('baudRate');
        const selectedBaud = parseInt(baudSelect.value, 10);
        const deviceCode = this.baudRateMap[selectedBaud];

        if (!(selectedBaud in this.baudRateMap)) {
            this.log(`Unsupported baud rate: ${selectedBaud}`, 'error');
            return;
        }

        if (!this.isConnected) {
            this.pendingBaudRate = selectedBaud;
            this.log(`Reconnect at ${selectedBaud} baud only if the device is already configured for it`, 'info');
            return;
        }

        if (this.awaitingBinaryScan || this.isContinuousScanning) {
            this.log('Stop acquisition before changing baud rate', 'error');
            return;
        }

        if (selectedBaud === this.baudRate) {
            this.log(`Already using ${selectedBaud} baud`, 'info');
            return;
        }

        this.log(`Requesting device baud change to ${selectedBaud}`, 'info');

        try {
            await this.writeCommand(`K${deviceCode}`);
            await new Promise(resolve => setTimeout(resolve, 250));

            this.pendingBaudRate = selectedBaud;
            await this.closeCurrentPort();
            await new Promise(resolve => setTimeout(resolve, 200));
            await this.openCurrentPort();

            this.updateConnectionUI(true);
            this.log(`Reconnected at ${selectedBaud} baud`, 'success');
            this.startReadingData();
        } catch (error) {
            this.isConnected = false;
            this.updateConnectionUI(false);
            this.log(`Baud rate transition failed: ${error.message}`, 'error');
            this.log('If the device stopped responding, power-cycle it and reconnect at 9600 baud', 'error');
        }
    }
}

// Global instance
let spectrograph = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    spectrograph = new SpectrographDiagnostic();
    
    // Set button handlers
    window.connectDevice = () => spectrograph.connectDevice();
    window.disconnectDevice = () => spectrograph.disconnectDevice();
    window.performScan = () => spectrograph.performScan();
    window.toggleContinuousScan = () => spectrograph.toggleContinuousScan();
    window.sendCommand = (cmd) => spectrograph.sendCommand(cmd);
    window.queryValue = (param) => spectrograph.queryValue(param);
    window.setSetting = (param) => spectrograph.setSetting(param);
    window.applyBaudRate = () => spectrograph.applyBaudRate();
    window.exportCubeRamanCSV = () => spectrograph.exportCubeRamanCSV();
    window.applyAxisCalibration = () => spectrograph.applyAxisCalibration();
    window.findCalibrationPeaks = () => spectrograph.findCalibrationPeaks();
    window.fitCalibrationPeaks = () => spectrograph.fitCalibrationPeaks();
    window.openSaveScanDialog = () => spectrograph.openSaveScanDialog();
    window.closeSaveScanDialog = () => spectrograph.closeSaveScanDialog();
    window.saveCurrentScanToDB = () => spectrograph.saveCurrentScanToDB();
    window.toggleStoredScans = (force) => spectrograph.toggleStoredScans(force);
    window.exportAllScansJSON = () => spectrograph.exportAllScansJSON();

    const csvImportFile = document.getElementById('csvImportFile');
    if (csvImportFile) {
        csvImportFile.addEventListener('change', event => {
            const file = event.target.files?.[0];
            spectrograph.importScanCSV(file);
        });
    }

    spectrograph.setupCollapsibleSections();
    spectrograph.setupHelpTooltips();
    spectrograph.loadControlSettings();

    const processingControlIds = [
        'analysisEnabled',
        'laserWavelength',
        'ramanMin',
        'ramanMax',
        'spikeEnabled',
        'spikeThreshold',
        'baselineMethod',
        'snipIterations',
        'lambdaPower',
        'smoothingMethod',
        'smoothingWindow',
        'smoothingOrder',
        'normalizationMethod',
        'peakHeightPercent',
        'peakDistance'
    ];

    processingControlIds.forEach(id => {
        const control = document.getElementById(id);
        if (!control) return;
        const eventName = control.type === 'checkbox' || control.tagName === 'SELECT' ? 'change' : 'input';
        control.addEventListener(eventName, () => {
            spectrograph.handleProcessingSettingsChanged();
            spectrograph.saveControlSettings();
        });
    });

    const axisCalibrationMode = document.getElementById('axisCalibrationMode');
    if (axisCalibrationMode) {
        axisCalibrationMode.addEventListener('change', () => {
            spectrograph.syncAxisCalibrationUI();
            spectrograph.saveControlSettings();
        });
    }
    spectrograph.syncAxisCalibrationUI();
    spectrograph.loadAxisCalibrationPreference();
    spectrograph.syncProcessingLabels();

    [
        'integrationTime',
        'averageCount',
        'baudRate',
        'wavelengthMin',
        'wavelengthMax',
        'calibrationC0',
        'calibrationC1',
        'calibrationC2',
        'calibrationC3',
        'calibrationPeakHeight',
        'calibrationPeakDistance',
        'calibrationFitOrder',
        'calibrationPeakLimit'
    ].forEach(id => {
        const control = document.getElementById(id);
        if (!control) return;
        const eventName = control.tagName === 'SELECT' ? 'change' : 'input';
        control.addEventListener(eventName, () => spectrograph.saveControlSettings());
    });

    const storedScanSort = document.getElementById('storedScanSort');
    if (storedScanSort) {
        storedScanSort.addEventListener('change', () => spectrograph.renderStoredScans());
    }

    const saveScanName = document.getElementById('saveScanName');
    if (saveScanName) {
        saveScanName.addEventListener('keydown', event => {
            if (event.key === 'Enter') spectrograph.saveCurrentScanToDB();
            if (event.key === 'Escape') spectrograph.closeSaveScanDialog();
        });
    }

    spectrograph.updateStorageUI();
    spectrograph.refreshStoredScans();
    
    // Setup resizable divider
    const divider = document.getElementById('resizableDivider');
    const wrapper = document.querySelector('.main-content-wrapper');
    const controlPanel = document.querySelector('.control-panel');
    const contentArea = document.querySelector('.content-area');
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    divider.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = controlPanel.offsetWidth;
        divider.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const diff = e.clientX - startX;
        const newWidth = Math.max(250, Math.min(startWidth + diff, wrapper.offsetWidth - 400));
        
        controlPanel.style.gridColumn = `1`;
        wrapper.style.gridTemplateColumns = `${newWidth}px 4px 1fr`;
        
        // Save preference
        localStorage.setItem('controlPanelWidth', newWidth);
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            divider.classList.remove('dragging');
            document.body.style.userSelect = 'auto';
            document.body.style.cursor = 'auto';
        }
    });

    // Restore saved width
    const savedWidth = localStorage.getItem('controlPanelWidth');
    if (savedWidth) {
        const width = parseInt(savedWidth, 10);
        wrapper.style.gridTemplateColumns = `${width}px 4px 1fr`;
    }
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (spectrograph && spectrograph.isConnected) {
        spectrograph.disconnectDevice();
    }
});
