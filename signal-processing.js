// Browser-side signal processing ported from CubeRaman-SpectrumPro_v2.py.
// Kept dependency-free so the app can still run as a static HTML page.

const RamanProcessing = (() => {
    const EPS = 1e-12;

    function finiteNumber(value, fallback = 0) {
        return Number.isFinite(value) ? value : fallback;
    }

    function mean(values) {
        if (!values.length) return 0;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function std(values) {
        if (values.length < 2) return 0;
        const m = mean(values);
        const variance = mean(values.map(value => (value - m) ** 2));
        return Math.sqrt(variance);
    }

    function trapz(y, x) {
        let area = 0;
        for (let i = 1; i < y.length; i += 1) {
            area += 0.5 * (Math.abs(y[i - 1]) + Math.abs(y[i])) * Math.abs(x[i] - x[i - 1]);
        }
        return area;
    }

    function nmToShift(wavelengthNm, laserNm = 532) {
        return (1e7 / laserNm) - (1e7 / wavelengthNm);
    }

    function normalize01(y) {
        const minValue = Math.min(...y);
        const maxValue = Math.max(...y);
        const range = maxValue - minValue;
        if (range <= EPS) return y.map(() => 0);
        return y.map(value => (value - minValue) / range);
    }

    function removeSpikes(y, threshold = 8.5) {
        if (y.length < 4) return { cleaned: [...y], removed: 0 };

        const dy = [];
        for (let i = 1; i < y.length; i += 1) {
            dy.push(y[i] - y[i - 1]);
        }

        const med = median(dy);
        const mad = median(dy.map(value => Math.abs(value - med)));
        const denom = 1.4826 * mad + EPS;
        const spikeStarts = [];

        dy.forEach((value, index) => {
            if (Math.abs(value - med) / denom > threshold) {
                spikeStarts.push(index);
            }
        });

        const cleaned = y.map(value => Number(value));
        let removed = 0;
        let i = 0;

        while (i < spikeStarts.length) {
            const start = spikeStarts[i];
            let end = start + 1;
            while (i + 1 < spikeStarts.length && spikeStarts[i + 1] === spikeStarts[i] + 1) {
                i += 1;
                end = spikeStarts[i] + 1;
            }

            const left = Math.max(0, start - 1);
            const right = Math.min(y.length - 1, end + 1);
            if (right > left) {
                for (let j = start; j <= end && j < cleaned.length; j += 1) {
                    const t = (j - left) / Math.max(right - left, 1);
                    cleaned[j] = cleaned[left] * (1 - t) + cleaned[right] * t;
                    removed += 1;
                }
            }
            i += 1;
        }

        return { cleaned, removed };
    }

    function buildPenaltyBands(n, lam, weights) {
        const diag = new Array(n).fill(0);
        const off1 = new Array(Math.max(0, n - 1)).fill(0);
        const off2 = new Array(Math.max(0, n - 2)).fill(lam);

        for (let i = 0; i < n; i += 1) {
            let coeff = 6;
            if (i === 0 || i === n - 1) coeff = 1;
            else if (i === 1 || i === n - 2) coeff = 5;
            diag[i] = weights[i] + lam * coeff;
        }

        for (let i = 0; i < n - 1; i += 1) {
            off1[i] = -4 * lam;
        }
        if (n > 1) {
            off1[0] = -2 * lam;
            off1[n - 2] = -2 * lam;
        }

        return { diag, off1, off2 };
    }

    function applyBands(bands, vector) {
        const n = vector.length;
        const result = new Array(n).fill(0);
        for (let i = 0; i < n; i += 1) {
            result[i] += bands.diag[i] * vector[i];
            if (i > 0) result[i] += bands.off1[i - 1] * vector[i - 1];
            if (i < n - 1) result[i] += bands.off1[i] * vector[i + 1];
            if (i > 1) result[i] += bands.off2[i - 2] * vector[i - 2];
            if (i < n - 2) result[i] += bands.off2[i] * vector[i + 2];
        }
        return result;
    }

    function dot(a, b) {
        let value = 0;
        for (let i = 0; i < a.length; i += 1) value += a[i] * b[i];
        return value;
    }

    function solveWhittaker(weights, y, lam, maxIter = 220, tol = 1e-7) {
        const n = y.length;
        if (n < 3) return [...y];

        const bands = buildPenaltyBands(n, lam, weights);
        const b = y.map((value, index) => weights[index] * value);
        let x = [...y];
        let ax = applyBands(bands, x);
        let r = b.map((value, index) => value - ax[index]);
        let z = r.map((value, index) => value / Math.max(bands.diag[index], EPS));
        let p = [...z];
        let rzOld = dot(r, z);
        const bNorm = Math.sqrt(dot(b, b)) + EPS;

        for (let iter = 0; iter < maxIter; iter += 1) {
            const ap = applyBands(bands, p);
            const alpha = rzOld / (dot(p, ap) + EPS);
            for (let i = 0; i < n; i += 1) {
                x[i] += alpha * p[i];
                r[i] -= alpha * ap[i];
            }

            if (Math.sqrt(dot(r, r)) / bNorm < tol) break;

            z = r.map((value, index) => value / Math.max(bands.diag[index], EPS));
            const rzNew = dot(r, z);
            const beta = rzNew / (rzOld + EPS);
            for (let i = 0; i < n; i += 1) {
                p[i] = z[i] + beta * p[i];
            }
            rzOld = rzNew;
        }

        return x.map(value => finiteNumber(value));
    }

    function baselineALS(y, lam = 1e5, p = 0.01, niter = 10) {
        let weights = new Array(y.length).fill(1);
        let z = [...y];
        for (let iter = 0; iter < niter; iter += 1) {
            z = solveWhittaker(weights, y, lam);
            weights = y.map((value, index) => (value > z[index] ? p : 1 - p));
        }
        return z;
    }

    function baselineARPLS(y, lam = 1e4, ratio = 0.05, niter = 50) {
        let weights = new Array(y.length).fill(1);
        let z = [...y];
        for (let iter = 0; iter < niter; iter += 1) {
            z = solveWhittaker(weights, y, lam);
            const d = y.map((value, index) => value - z[index]);
            const negative = d.filter(value => value < 0);
            const m = negative.length ? mean(negative) : 0;
            const s = negative.length > 1 ? std(negative) : 1;
            const nextWeights = d.map(value => 1 / (1 + Math.exp(2 * (value - (2 * s - m)) / (s + EPS))));
            const delta = Math.sqrt(weights.reduce((sum, value, index) => sum + (nextWeights[index] - value) ** 2, 0));
            const norm = Math.sqrt(weights.reduce((sum, value) => sum + value ** 2, 0)) + EPS;
            weights = nextWeights;
            if (delta / norm < ratio) break;
        }
        return z;
    }

    function baselineSNIP(y, maxIter = 11) {
        const n = y.length;
        let v = y.map(value => Math.log(Math.log(Math.sqrt(Math.max(value, 0) + 1) + 1) + 1));
        for (let iter = 1; iter <= maxIter; iter += 1) {
            const next = [...v];
            for (let i = iter; i < n - iter; i += 1) {
                next[i] = Math.min(v[i], (v[i - iter] + v[i + iter]) / 2);
            }
            v = next;
        }
        return v.map(value => (Math.exp(Math.exp(value) - 1) - 1) ** 2 - 1);
    }

    function gaussianSolve(matrix, rhs) {
        const n = rhs.length;
        const a = matrix.map((row, i) => [...row, rhs[i]]);
        for (let col = 0; col < n; col += 1) {
            let pivot = col;
            for (let row = col + 1; row < n; row += 1) {
                if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
            }
            if (Math.abs(a[pivot][col]) < EPS) return null;
            if (pivot !== col) [a[col], a[pivot]] = [a[pivot], a[col]];
            const div = a[col][col];
            for (let j = col; j <= n; j += 1) a[col][j] /= div;
            for (let row = 0; row < n; row += 1) {
                if (row === col) continue;
                const factor = a[row][col];
                for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
            }
        }
        return a.map(row => row[n]);
    }

    function savitzkyGolay(y, windowSize = 7, order = 3) {
        let win = Math.max(3, Math.round(windowSize));
        if (win % 2 === 0) win += 1;
        const polyOrder = Math.max(1, Math.min(Math.round(order), win - 2));
        const half = Math.floor(win / 2);
        const size = polyOrder + 1;
        const ata = Array.from({ length: size }, () => new Array(size).fill(0));
        const rhs = new Array(size).fill(0);
        rhs[0] = 1;

        for (let row = 0; row < size; row += 1) {
            for (let col = 0; col < size; col += 1) {
                let sum = 0;
                for (let k = -half; k <= half; k += 1) {
                    sum += k ** (row + col);
                }
                ata[row][col] = sum;
            }
        }

        const projection = gaussianSolve(ata, rhs);
        if (!projection) return [...y];

        const coeffs = [];
        for (let k = -half; k <= half; k += 1) {
            let coeff = 0;
            for (let j = 0; j < projection.length; j += 1) {
                coeff += projection[j] * (k ** j);
            }
            coeffs.push(coeff);
        }

        return y.map((_, index) => {
            let value = 0;
            for (let k = -half; k <= half; k += 1) {
                const src = Math.max(0, Math.min(y.length - 1, index + k));
                value += coeffs[k + half] * y[src];
            }
            return value;
        });
    }

    function movingAverage(y, windowSize = 7) {
        const win = Math.max(1, Math.round(windowSize));
        const half = Math.floor(win / 2);
        return y.map((_, index) => {
            let sum = 0;
            let count = 0;
            for (let k = -half; k <= half; k += 1) {
                const src = index + k;
                if (src >= 0 && src < y.length) {
                    sum += y[src];
                    count += 1;
                }
            }
            return sum / Math.max(count, 1);
        });
    }

    function normalize(y, x, method = "max") {
        if (method === "none") return [...y];
        if (method === "area") {
            const area = trapz(y, x);
            return area > EPS ? y.map(value => value / area) : [...y];
        }
        if (method === "snv") {
            const m = mean(y);
            const s = std(y) + EPS;
            return y.map(value => (value - m) / s);
        }
        const maxAbs = Math.max(...y.map(value => Math.abs(value)));
        return maxAbs > EPS ? y.map(value => value / maxAbs) : [...y];
    }

    function findPeaks(y, { minHeight = 0, minDistance = 1, prominence = 0 } = {}) {
        const candidates = [];
        for (let i = 1; i < y.length - 1; i += 1) {
            if (y[i] > y[i - 1] && y[i] >= y[i + 1] && y[i] >= minHeight) {
                const leftMin = Math.min(...y.slice(Math.max(0, i - minDistance), i + 1));
                const rightMin = Math.min(...y.slice(i, Math.min(y.length, i + minDistance + 1)));
                const localProminence = y[i] - Math.max(leftMin, rightMin);
                if (localProminence >= prominence) {
                    candidates.push({ index: i, y: y[i] });
                }
            }
        }

        candidates.sort((a, b) => b.y - a.y);
        const selected = [];
        for (const candidate of candidates) {
            if (selected.every(peak => Math.abs(peak.index - candidate.index) >= minDistance)) {
                selected.push(candidate);
            }
        }
        return selected.sort((a, b) => a.index - b.index);
    }

    function pseudoVoigt(x, centre, amplitude, fwhm, eta) {
        const boundedEta = Math.max(0, Math.min(1, eta));
        const width = Math.abs(fwhm) + EPS;
        const sigma = width / (2 * Math.sqrt(2 * Math.log(2)));
        const gaussian = Math.exp(-((x - centre) ** 2) / (2 * sigma ** 2));
        const lorentzian = 1 / (1 + ((x - centre) / (width / 2)) ** 2);
        return amplitude * (boundedEta * lorentzian + (1 - boundedEta) * gaussian);
    }

    function fitPeak(x, y, centreGuess, windowCm = 80) {
        const samples = x
            .map((value, index) => ({ x: value, y: y[index] }))
            .filter(point => Math.abs(point.x - centreGuess) <= windowCm);

        if (samples.length < 6) {
            throw new Error("Too few points in fit window.");
        }

        const xFit = samples.map(point => point.x);
        const yFit = samples.map(point => point.y);
        const maxY = Math.max(...yFit);
        const minX = Math.min(...xFit);
        const maxX = Math.max(...xFit);
        let params = [centreGuess, Math.max(maxY, EPS), windowCm * 0.3, 0.5];

        const clampParams = values => [
            Math.max(minX, Math.min(maxX, values[0])),
            Math.max(0, Math.min(Math.max(maxY * 5, EPS), values[1])),
            Math.max(1, Math.min(windowCm * 2, Math.abs(values[2]))),
            Math.max(0, Math.min(1, values[3]))
        ];

        const score = values => {
            const p = clampParams(values);
            let err = 0;
            for (let i = 0; i < xFit.length; i += 1) {
                const diff = pseudoVoigt(xFit[i], p[0], p[1], p[2], p[3]) - yFit[i];
                err += diff * diff;
            }
            return err / xFit.length;
        };

        let steps = [windowCm * 0.12, Math.max(maxY * 0.2, EPS), windowCm * 0.08, 0.12];
        let bestScore = score(params);

        for (let iter = 0; iter < 90; iter += 1) {
            let improved = false;
            for (let dim = 0; dim < params.length; dim += 1) {
                for (const direction of [-1, 1]) {
                    const candidate = [...params];
                    candidate[dim] += direction * steps[dim];
                    const clamped = clampParams(candidate);
                    const candidateScore = score(clamped);
                    if (candidateScore < bestScore) {
                        params = clamped;
                        bestScore = candidateScore;
                        improved = true;
                    }
                }
            }
            if (!improved) {
                steps = steps.map(step => step * 0.55);
                if (Math.max(...steps) < 1e-5) break;
            }
        }

        params = clampParams(params);
        const denseCount = 500;
        const xDense = Array.from({ length: denseCount }, (_, index) => (
            minX + (index / (denseCount - 1)) * (maxX - minX)
        ));
        const yDense = xDense.map(value => pseudoVoigt(value, ...params));

        return {
            centre: params[0],
            amplitude: params[1],
            fwhm: params[2],
            eta: params[3],
            area: trapz(yDense, xDense),
            rmse: Math.sqrt(bestScore),
            xFit: xDense,
            yFit: yDense,
            xData: xFit,
            yData: yFit
        };
    }

    function interpolate(x, y, targetX) {
        if (targetX <= x[0]) return y[0];
        if (targetX >= x[x.length - 1]) return y[y.length - 1];
        let lo = 0;
        let hi = x.length - 1;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (x[mid] <= targetX) lo = mid;
            else hi = mid;
        }
        const t = (targetX - x[lo]) / (x[hi] - x[lo] + EPS);
        return y[lo] * (1 - t) + y[hi] * t;
    }

    function cosineSimilarity(queryX, queryY, libX, libY, wnMin = 300, wnMax = 3400, nPoints = 1000) {
        const grid = Array.from({ length: nPoints }, (_, index) => (
            wnMin + (index / (nPoints - 1)) * (wnMax - wnMin)
        ));
        const q = grid.map(value => interpolate(queryX, queryY, value));
        const l = grid.map(value => interpolate(libX, libY, value));
        const qNorm = Math.sqrt(dot(q, q));
        const lNorm = Math.sqrt(dot(l, l));
        if (qNorm <= EPS || lNorm <= EPS) return 0;
        return dot(q, l) / (qNorm * lNorm);
    }

    function matchPeaksToLibrary(queryPeaks, library, {
        toleranceCm = 30,
        requireFraction = 0.4,
        topN = 10
    } = {}) {
        if (!queryPeaks.length) return [];
        const q = queryPeaks.map(peak => Number(peak.x ?? peak));
        const results = [];

        for (const entry of library) {
            const spectralData = entry.spectral_data || entry.spectralData;
            const xAxis = entry.x_axis || entry.xAxis;
            if (!Array.isArray(spectralData) || !Array.isArray(xAxis) || spectralData.length < 10) continue;

            const yNorm = normalize01(spectralData.map(Number));
            const dx = Math.abs(mean(xAxis.slice(1).map((value, index) => value - xAxis[index]))) || 1;
            const minDistance = Math.max(1, Math.round(25 / dx));
            let peakIdx = findPeaks(yNorm, { minHeight: 0.05, minDistance, prominence: 0.03 }).map(peak => peak.index);
            if (!peakIdx.length) {
                peakIdx = findPeaks(yNorm, { minHeight: 0.05, minDistance }).map(peak => peak.index);
            }
            const libPeaks = peakIdx.map(index => Number(xAxis[index]));
            const used = new Set();
            const matchedPairs = [];

            for (const queryPeak of q) {
                let bestIndex = -1;
                let bestDiff = Infinity;
                libPeaks.forEach((libPeak, index) => {
                    const diff = Math.abs(libPeak - queryPeak);
                    if (!used.has(index) && diff < bestDiff) {
                        bestDiff = diff;
                        bestIndex = index;
                    }
                });
                if (bestIndex >= 0 && bestDiff <= toleranceCm) {
                    used.add(bestIndex);
                    matchedPairs.push([queryPeak, libPeaks[bestIndex]]);
                }
            }

            const coverage = matchedPairs.length / Math.max(q.length, 1);
            if (coverage < requireFraction) continue;

            const errors = matchedPairs.map(([queryPeak, libPeak]) => Math.abs(queryPeak - libPeak));
            results.push({
                name: entry.name || entry.substance_name || entry.substanceName || "Unknown",
                substanceName: entry.substance_name || entry.substanceName || "",
                score: matchedPairs.length / Math.max(q.length, libPeaks.length, 1),
                matchedPairs,
                nMatched: matchedPairs.length,
                nQuery: q.length,
                nLib: libPeaks.length,
                meanError: errors.length ? mean(errors) : null,
                maxError: errors.length ? Math.max(...errors) : null,
                libPeaks,
                xAxis,
                spectralData,
                entry
            });
        }

        return results.sort((a, b) => b.score - a.score).slice(0, topN);
    }

    function processSpectrum(wavelengths, intensities, options = {}) {
        const laserNm = finiteNumber(options.laserNm, 532);
        const xAll = wavelengths.map(wavelength => nmToShift(wavelength, laserNm));
        const xmin = finiteNumber(options.xMin, Math.min(...xAll));
        const xmax = finiteNumber(options.xMax, Math.max(...xAll));
        const low = Math.min(xmin, xmax);
        const high = Math.max(xmin, xmax);
        const points = [];

        for (let i = 0; i < xAll.length; i += 1) {
            if (xAll[i] >= low && xAll[i] <= high && Number.isFinite(intensities[i])) {
                points.push({ index: i, x: xAll[i], raw: Number(intensities[i]) });
            }
        }

        if (points.length < 5) {
            return {
                x: [],
                raw: [],
                cleaned: [],
                baseline: [],
                processed: [],
                peaks: [],
                spikeCount: 0,
                stats: { pointCount: points.length, peakIntensity: 0, snr: 0 }
            };
        }

        const x = points.map(point => point.x);
        const raw = points.map(point => point.raw);
        let cleaned = [...raw];
        let spikeCount = 0;

        if (options.spikeEnabled !== false) {
            const spikeResult = removeSpikes(cleaned, finiteNumber(options.spikeThreshold, 8.5));
            cleaned = spikeResult.cleaned;
            spikeCount = spikeResult.removed;
        }

        let baseline;
        const baselineMethod = options.baselineMethod || "snip";
        if (baselineMethod === "als") {
            baseline = baselineALS(cleaned, 10 ** finiteNumber(options.lambdaPower, 3.2), finiteNumber(options.asymmetry, 0.01));
        } else if (baselineMethod === "arpls") {
            baseline = baselineARPLS(cleaned, 10 ** finiteNumber(options.lambdaPower, 3.2), finiteNumber(options.asymmetry, 0.01));
        } else if (baselineMethod === "none") {
            baseline = new Array(cleaned.length).fill(0);
        } else {
            baseline = baselineSNIP(cleaned, Math.round(finiteNumber(options.snipIterations, 11)));
        }

        let processed = cleaned.map((value, index) => value - baseline[index]);
        const smoothing = options.smoothing || "sg";
        if (smoothing === "sg") {
            processed = savitzkyGolay(processed, finiteNumber(options.smoothingWindow, 7), finiteNumber(options.smoothingOrder, 3));
        } else if (smoothing === "moving") {
            processed = movingAverage(processed, finiteNumber(options.smoothingWindow, 7));
        }

        processed = normalize(processed, x, options.normalization || "max");

        let peaks = [];
        if (options.peaksEnabled !== false && processed.length > 5) {
            const maxProcessed = Math.max(...processed);
            const meanDx = Math.abs(mean(x.slice(1).map((value, index) => value - x[index]))) || 1;
            const minDistance = Math.max(1, Math.round(finiteNumber(options.peakDistance, 30) / meanDx));
            const minHeight = (finiteNumber(options.peakHeightPercent, 12) / 100) * maxProcessed;
            peaks = findPeaks(processed, { minHeight, minDistance }).map(peak => ({
                index: peak.index,
                x: x[peak.index],
                y: processed[peak.index]
            }));
        }

        const tailStart = Math.floor(processed.length * 0.85);
        const noise = std(processed.slice(tailStart)) + EPS;
        const peakIntensity = Math.max(...processed);

        return {
            x,
            raw,
            cleaned,
            baseline,
            processed,
            peaks,
            spikeCount,
            stats: {
                pointCount: processed.length,
                peakIntensity,
                peakCount: peaks.length,
                snr: peakIntensity / noise,
                rangeMin: Math.min(...x),
                rangeMax: Math.max(...x)
            }
        };
    }

    return {
        nmToShift,
        normalize01,
        removeSpikes,
        baselineALS,
        baselineARPLS,
        baselineSNIP,
        savitzkyGolay,
        movingAverage,
        findPeaks,
        pseudoVoigt,
        fitPeak,
        cosineSimilarity,
        matchPeaksToLibrary,
        processSpectrum
    };
})();
