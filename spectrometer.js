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
                labels: this.generateWavelengthLabels(),
                datasets: [{
                    label: 'Spectral Intensity',
                    data: [],
                    borderColor: '#667eea',
                    backgroundColor: 'rgba(102, 126, 234, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    spanGaps: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                animation: false,
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Wavelength (nm)'
                        },
                        min: this.wavelengthMin,
                        max: this.wavelengthMax
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Intensity (counts)'
                        },
                        min: 0,
                        max: 65535
                    }
                }
            }
        });
    }

    generateWavelengthLabels() {
        const labels = [];
        const step = Math.floor(this.pixelCount / 50); // ~50 labels
        for (let i = 0; i < this.pixelCount; i += step) {
            const wavelength = this.pixelToWavelength(i);
            labels.push(wavelength.toFixed(0));
        }
        return labels;
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

            // Request port from user
            this.port = await navigator.serial.requestPort();
            
            // Open port with BTC100-2S settings: 9600 baud, 8n1
            await this.port.open({
                baudRate: 9600,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none'
            });

            this.isConnected = true;
            this.reader = this.port.readable.getReader();
            this.writer = this.port.writable.getWriter();
            
            this.updateConnectionUI(true);
            this.log('Connected to spectrometer', 'success');
            
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
            
            if (this.reader) {
                this.reader.cancel();
            }
            
            if (this.writer) {
                this.writer.close();
            }
            
            if (this.port) {
                await this.port.close();
            }
            
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

        if (connected) {
            indicator.className = 'status-indicator connected';
            status.textContent = 'Connected';
            connectBtn.disabled = true;
            disconnectBtn.disabled = false;
            scanBtn.disabled = false;
            continuousScanBtn.disabled = false;
        } else {
            indicator.className = 'status-indicator disconnected';
            status.textContent = 'Disconnected';
            connectBtn.disabled = false;
            disconnectBtn.disabled = true;
            scanBtn.disabled = true;
            continuousScanBtn.disabled = true;
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
                    const remainder = this.extractAsciiLines(bytes);
                    if (remainder.length > 0) {
                        const buffer = new Uint8Array(this.binaryBuffer.length + remainder.length);
                        buffer.set(this.binaryBuffer);
                        buffer.set(remainder, this.binaryBuffer.length);
                        this.binaryBuffer = buffer;
                        this.tryParseBinaryBuffer();
                    }
                }
            }
        } catch (error) {
            if (this.isConnected) {
                this.log(`Read error: ${error.message}`, 'error');
            }
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
            this.updateChart();
            this.updateStatistics();
        } else {
            this.log(`Data incomplete: received ${data.length} but need at least ${Math.floor(this.pixelCount * 0.95)}`, 'error');
        }
    }

    tryParseBinaryBuffer() {
        const result = this.parseBinaryData(this.binaryBuffer);
        if (result.complete) {
            this.binaryBuffer = this.binaryBuffer.slice(result.consumedBytes);
            this.currentData = result.values;
            this.awaitingBinaryScan = false;
            this.log('Binary scan completed', 'success');
            this.updateChart();
            this.updateStatistics();
        }
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

    updateChart() {
        if (!this.currentData || this.currentData.length === 0) {
            this.log('No data to display in chart', 'error');
            return;
        }

        try {
            const labels = [];
            for (let i = 0; i < this.currentData.length; i += Math.max(1, Math.floor(this.currentData.length / 100))) {
                const wavelength = this.pixelToWavelengthCalibrated(i);
                labels.push(wavelength.toFixed(1));
            }

            this.chart.data.labels = labels;
            this.chart.data.datasets[0].data = this.currentData;
            this.chart.options.scales.y.suggestedMin = 0;
            this.chart.options.scales.y.max = undefined;
            this.chart.options.scales.y.beginAtZero = true;

            this.chart.update('none');
            this.log(`Chart rendered with ${this.currentData.length} points`, 'success');
        } catch (error) {
            this.log(`Chart update error: ${error.message}`, 'error');
        }
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
        this.writeCommand('S');
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
            this.writeCommand('S');
            await new Promise(resolve => setTimeout(resolve, 500));
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
