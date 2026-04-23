# BTC100-2S Spectrometer Diagnostic Toolkit

A modern web-based diagnostic application for interfacing with the B&W Tek BTC100-2S spectrometer via USB-RS232 (FTDI adapter) using the WebSerial API.

## Features

- ✅ **Real-time Spectral Data Acquisition**: Capture and visualize spectral data in real-time
- ✅ **Live Chart Visualization**: Interactive Chart.js-based spectrum display
- ✅ **ASCII Mode Support**: Human-readable data format for easy debugging
- ✅ **Binary Mode Support**: Compressed data encoding for efficient transfers
- ✅ **Device Diagnostics**: Query and configure device parameters
- ✅ **Calibration Support**: Wavelength calibration via polynomial fit (c0, c1, c2, c3)
- ✅ **Statistics Display**: Peak wavelength, intensity, and noise floor analysis
- ✅ **Command Logging**: Real-time log of all device communications
- ✅ **Continuous Scanning**: Acquire multiple spectra sequentially
- ✅ **Integration Time Control**: Adjust sensor integration time (50-65000ms)
- ✅ **Averaging**: Configure multi-sample averaging

## Hardware Requirements

- **B&W Tek BTC100-2S Spectrometer** with RS232 port
- **USB-RS232 Adapter** (FTDI-based strongly recommended)
- **Computer** with Chrome, Edge, or Opera browser (WebSerial support required)
- **USB Cable** connecting adapter to computer

## Software Requirements

- Modern browser with WebSerial API support:
  - Chrome/Chromium 89+
  - Microsoft Edge 89+
  - Opera 76+
  - Android Chrome 89+
  - NOT supported in Firefox or Safari (as of 2024)

## Quick Start

1. **Connect Hardware**:
   - Power on the BTC100-2S spectrometer
   - Connect USB-RS232 adapter to your computer
   - Wait for device to boot (LED will glow red)

2. **Open Application**:
   - Open `index.html` in a supported browser
   - The application will load the diagnostic interface

3. **Connect via WebSerial**:
   - Click the **"Connect Device"** button
   - A browser dialog will appear - select your USB-RS232 adapter port
   - If connection succeeds, the status indicator will turn green

4. **Acquire Data**:
   - Click **"Acquire Scan"** to get a single spectral reading
   - Or click **"Start Continuous"** for multiple readings

5. **View Results**:
   - Spectral data displays in the main chart
   - Peak wavelength and intensity appear in the statistics panel
   - All commands/responses logged in the control panel

## Device Communication Protocol

The BTC100-2S uses a simple RS232-based text protocol at **9600 baud, 8N1, no flow control**.

### Command Set

| Command | Description | Example |
|---------|-------------|---------|
| `A{int}` | Set averaging count | `A10` (average 10 spectra) |
| `I{int}` | Set integration time (ms) | `I500` (500ms integration) |
| `K{int}` | Set baud rate | `K3` (9600 baud) |
| `Q` | Reset device to defaults | `Q` |
| `S` | Initiate scan and return data | `S` |
| `a` | Enable ASCII mode | `a` |
| `b` | Enable binary mode | `b` |
| `?{letter}` | Query parameter value | `?A` (query averaging) |

### Data Formats

#### ASCII Mode (`a` command)
Returns 2048 pixel values as whitespace-separated integers (one line):
```
1240 1250 1238 ... (2048 values total)
```
Each value is a uint16 (0-65535) representing the spectral intensity at that pixel.

#### Binary Mode (`b` command)
More efficient encoding where each pixel is compared to the previous:
- If difference ≤ ±127: send single signed byte representing the difference
- If difference > 127 or < -127: send `0x80` flag followed by full 16-bit value

## Calibration

### Default Linear Calibration
By default, the application uses a linear wavelength mapping:
- **Pixel 0** → 400 nm (blue)
- **Pixel 2047** → 580 nm (red)
- Operating range: 400-580 nm

### Polynomial Calibration
For better accuracy, calibrate using known reference wavelengths:

1. Point the spectrometer at a CFL or discharge lamp
2. Identify spectral peaks using reference data (e.g., Mercury: 404.7, 435.8, 546.1, 579.0 nm)
3. Record pixel positions of known wavelengths
4. In the browser console, call:
   ```javascript
   spectrograph.updateCalibration(c0, c1, c2, c3);
   ```
   Where coefficients create the fit: λ = c0 + c1×pixel + c2×pixel² + c3×pixel³

### Example Calibration (Console)
```javascript
// CFL calibration data for this unit
spectrograph.updateCalibration(404.2, 0.0865, 0.00000, 0.00000);
```

## Usage Examples

### 1. Basic Diagnostic
```
1. Connect device
2. Click "Reset Device" (sends Q command)
3. Click "Acquire Scan" (sends S command)
4. View spectrum in chart
```

### 2. Continuous Monitoring
```
1. Set Integration Time to 200ms
2. Set Averaging to 3
3. Click "Start Continuous"
4. Data will update every ~500ms
```

### 3. Query Device Settings
```
1. Click "Query Average" to see current averaging setting
2. Click "Query Integration" to see current integration time
3. Response appears in log
```

### 4. Adjust Sensitivity
```
1. For brighter lights: decrease Integration Time (e.g., 50ms)
2. For dim lights: increase Integration Time (e.g., 5000ms)
3. For noisy data: increase Averaging count
```

## Troubleshooting

### "WebSerial API not available"
- **Cause**: Browser doesn't support WebSerial
- **Solution**: Use Chrome, Edge, or Opera (latest versions)

### Device not appearing in port selection
- **Cause**: USB adapter not recognized or not plugged in
- **Solution**: 
  - Check physical connection
  - Try different USB port
  - Install FTDI drivers if using FTDI adapter
  - Restart browser

### "Disconnected" after connecting
- **Cause**: Serial communication interrupted
- **Solution**:
  - Check USB cable
  - Reconnect USB adapter
  - Power cycle spectrometer
  - Try different USB port

### No spectrum data appearing
- **Cause**: Device hasn't entered ASCII mode or integration time too high
- **Solution**:
  - Click "ASCII Mode" button to ensure correct format
  - Try "Acquire Scan" instead of "Start Continuous"
  - Ensure light is reaching the spectrometer input

### Spectrum is flat/noisy
- **Cause**: Sensor noise, poor calibration, or saturated signal
- **Solution**:
  - Let TEC cooler run 5-10 minutes before taking measurements
  - Set background baseline (ensure lens is blocked)
  - Adjust light intensity
  - Increase averaging count

### "Saturation" (flat line at top)
- **Cause**: Too much light reaching sensor
- **Solution**: Reduce light intensity or move light source away

## Data Interpretation

- **Wavelength Range**: 400-580 nm (designed range for BTC100-2S)
- **Pixel Count**: 2048 pixels total
- **Max Value**: 65535 counts (uint16 maximum)
- **Noise Floor**: Expected ~1000-2000 counts on cold sensor with no input
- **Peak**: Strongest spectral line appears at highest counts

## Advanced Configuration

### Via Browser Console

Access advanced features via browser DevTools console:

```javascript
// Manual calibration
spectrograph.updateCalibration(380, 0.0873, 0.00001, 0.000000);

// Direct command send
spectrograph.writeCommand("I1000");  // 1000ms integration

// Access current data
console.log(spectrograph.currentData);

// Change wavelength range
spectrograph.wavelengthMin = 350;
spectrograph.wavelengthMax = 700;
spectrograph.initializeChart();
```

## File Structure

```
spectrotoy/
├── index.html          # Main UI (HTML + CSS)
├── spectrometer.js     # Core application logic
└── README.md           # This file
```

## Performance Notes

- **Update Rate**: Limited by USB latency and device response time (~100-500ms)
- **Data Transfer**: ASCII mode ~20-50ms per scan; Binary mode ~10-20ms per scan
- **Chart Rendering**: Smooth with ~100 data points; may lag with extreme zooming

## Known Limitations

1. **Firefox/Safari**: WebSerial not supported; use Chrome/Edge/Opera
2. **Mobile**: WebSerial limited; works better on desktop/Android
3. **Wavelength Calibration**: Requires manual setup with reference light sources
4. **Binary Mode**: Not fully tested on all platforms; ASCII mode more reliable

## Security Notes

- WebSerial API only works on HTTPS or localhost
- Port selection requires explicit user interaction
- No credentials or authentication (open RS232 protocol)

## References

- [B&W Tek BTC100-2S Documentation](https://bwtek.com/) (limited public availability)
- [Russell Graves' Spectrometry Article](https://www.sevarg.net/2023/01/28/bw-tek-btc100-spectrometer/)
- [WebSerial API Specification](https://wicg.github.io/serial/)
- [Chart.js Documentation](https://www.chartjs.org/)

## Future Enhancements

- [ ] Binary mode improvements and testing
- [ ] CSV export functionality
- [ ] Multi-point wavelength calibration UI
- [ ] Background subtraction
- [ ] Peak detection and labeling
- [ ] Integration with spectral reference database
- [ ] Dark current compensation
- [ ] Persistence and data logging
- [ ] Real-time FFT analysis

## Troubleshooting Checklist

```
□ Browser supports WebSerial (Chrome 89+, Edge 89+, Opera 76+)
□ USB adapter is connected and recognized by OS
□ Spectrometer is powered on (LED glowing red)
□ FTDI drivers installed (if using FTDI adapter)
□ Correct port selected from browser dialog
□ Device responds to "Reset Device" command
□ Light source is directed into spectrometer input
□ Sensor not saturated (reduce light if needed)
□ TEC cooler has had time to stabilize (5-10 minutes)
```

## Support

If you encounter issues:

1. Check the **Log** panel for actual device responses
2. Open browser **DevTools** (F12) for console messages
3. Verify USB connection and adapter drivers
4. Try the basic diagnostic commands first
5. Reference the device protocol section above

## License

This application is provided as-is for educational and diagnostic purposes.
