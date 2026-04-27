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
        this.asciiMode = true;
        this.awaitingBinaryScan = false;
        this.textBuffer = '';
        this.binaryBuffer = new Uint8Array();
        this.baudRate = 9600;
        this.pendingBaudRate = 9600;
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
        
        // Pixel to wavelength calibration (default linear calibration)
        // BTC100-2S operates 400-580nm range, 2048 pixels
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

    initializeChart() {
        const ctx = document.getElementById('spectrumChart').getContext('2d');
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Spectral Intensity',
                    data: [],
                    borderColor: '#1f8fff',
                    backgroundColor: 'rgba(31, 143, 255, 0.14)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.18,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    spanGaps: false,
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
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
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
                                return `${items[0].parsed.x.toFixed(1)} nm`;
                            },
                            label: (item) => `Intensity: ${Math.round(item.parsed.y).toLocaleString()} counts`
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Wavelength (nm)',
                            color: '#8ea2b8'
                        },
                        min: this.wavelengthMin,
                        max: this.wavelengthMax,
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
    }

    pixelToWavelength(pixel) {
        return this.wavelengthMin + 
               (pixel / this.pixelCount) * (this.wavelengthMax - this.wavelengthMin);
    }

    wavelengthToPixel(wavelength) {
        return Math.floor(((wavelength - this.wavelengthMin) / 
                (this.wavelengthMax - this.wavelengthMin)) * this.pixelCount);
    }

    updateCalibration(c0, c1, c2, c3) {
        // Set polynomial calibration: wavelength = c0 + c1*p + c2*p^2 + c3*p^3
        this.c0 = c0;
        this.c1 = c1;
        this.c2 = c2;
        this.c3 = c3;
        this.log(`Calibration updated: c0=${c0}, c1=${c1}, c2=${c2}, c3=${c3}`, 'info');
    }

    pixelToWavelengthCalibrated(pixel) {
        if (this.c1 === undefined) {
            return this.pixelToWavelength(pixel); // Use linear if not calibrated
        }
        return this.c0 + this.c1 * pixel + this.c2 * pixel * pixel + 
               this.c3 * pixel * pixel * pixel;
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
            
            // Query device status
            await new Promise(resolve => setTimeout(resolve, 500));
            this.sendCommand('Q'); // Reset to known state

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

    updateExportUI() {
        const exportBtn = document.getElementById('exportCubeRamanBtn');
        if (exportBtn) {
            exportBtn.disabled = !(Array.isArray(this.currentData) && this.currentData.length > 0);
        }
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

    parseASCIIData(values) {
        // Handle both array input and string input for flexibility
        let data = Array.isArray(values) ? values : values.trim().split(/\s+/).map(v => parseInt(v, 10));
        data = data.filter(v => !isNaN(v));
        
        this.log(`Parsed ${data.length} values (expected ${this.pixelCount})`, 'info');
        
        // Accept data within 5% of expected pixel count
        // Some devices might have slight variations
        if (data.length >= this.pixelCount * 0.95) {
            // Truncate or pad to exact pixel count
            if (data.length > this.pixelCount) {
                data = data.slice(0, this.pixelCount);
            } else if (data.length < this.pixelCount) {
                // Pad with last value if short
                const lastVal = data[data.length - 1] || 0;
                while (data.length < this.pixelCount) {
                    data.push(lastVal);
                }
            }
            
            this.currentData = data;
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
            const chartData = data.map((value, index) => ({
                x: this.pixelToWavelengthCalibrated(index),
                y: value
            }));

            this.chart.data.datasets[0].data = chartData;
            this.chart.data.datasets[1].data = this.buildCursorLine(data, hotIndex);
            this.chart.options.scales.x.min = this.pixelToWavelengthCalibrated(0);
            this.chart.options.scales.x.max = this.pixelToWavelengthCalibrated(this.pixelCount - 1);
            this.chart.options.scales.y.suggestedMin = 0;
            this.chart.options.scales.y.max = undefined;
            this.chart.options.scales.y.beginAtZero = true;

            this.chart.update('none');
            if (final) {
                this.log(`Chart rendered with ${data.length} points`, 'success');
            }
        } catch (error) {
            this.log(`Chart update error: ${error.message}`, 'error');
        }
    }

    buildCursorLine(data, hotIndex) {
        if (hotIndex === null || hotIndex < 0 || hotIndex >= this.pixelCount) {
            return [];
        }

        const yMax = Math.max(1, ...data);
        const x = this.pixelToWavelengthCalibrated(Math.min(hotIndex, this.pixelCount - 1));
        return [
            { x, y: 0 },
            { x, y: yMax }
        ];
    }

    updateStatistics() {
        if (!this.currentData) return;

        const data = this.currentData;
        
        // Find peak
        const maxValue = Math.max(...data);
        const maxIndex = data.indexOf(maxValue);
        const peakWavelength = this.pixelToWavelengthCalibrated(maxIndex);

        // Calculate noise floor (lower quartile)
        const sorted = [...data].sort((a, b) => a - b);
        const q1Index = Math.floor(sorted.length * 0.25);
        const noiseFloor = sorted[q1Index];

        // Update UI
        document.getElementById('peakWavelength').textContent = peakWavelength.toFixed(1);
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
            this.log('Switched to ASCII mode', 'info');
        } else if (command === 'b') {
            this.asciiMode = false;
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

    buildCubeRamanCSV() {
        if (!Array.isArray(this.currentData) || this.currentData.length === 0) {
            throw new Error('No spectrum data available to export');
        }

        const laserWavelength = parseFloat(document.getElementById('laserWavelength')?.value);
        const integrationTime = parseInt(document.getElementById('integrationTime')?.value, 10);
        const averageCount = parseInt(document.getElementById('averageCount')?.value, 10);
        const laserText = Number.isFinite(laserWavelength) ? `${laserWavelength} nm` : 'unknown';
        const integrationText = Number.isFinite(integrationTime) ? `${integrationTime} ms` : 'unknown';
        const averageText = Number.isFinite(averageCount) ? averageCount : 'unknown';

        const lines = [
            'CubeRaman-compatible export from SpectroToy',
            `Laser wavelength: ${laserText}`,
            `Integration time: ${integrationText}; scans averaged: ${averageText}`,
            '',
            'Wavelength,Averaged'
        ];

        this.currentData.forEach((intensity, pixel) => {
            const wavelength = this.pixelToWavelengthCalibrated(pixel);
            lines.push(`${wavelength.toFixed(3)},${Math.round(intensity)}`);
        });

        return lines.join('\n');
    }

    exportCubeRamanCSV() {
        try {
            const csv = this.buildCubeRamanCSV();
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const link = document.createElement('a');

            link.href = url;
            link.download = `spectrotoy-cuberaman-${timestamp}.csv`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);

            this.log(`Exported CubeRaman CSV with ${this.currentData.length} rows`, 'success');
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
