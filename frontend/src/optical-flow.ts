/** Small-frame, spatially distributed block matching. No external CV runtime.
 * Estimates dominant image displacement, not metric 3D camera translation.
 */
export interface FlowResult {
  dx: number;
  dy: number;
  quality: number;
  features: number;
  matches: number;
  message: string;
}

const PATCH = 2;
const SEARCH = 8;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cornerScore(image: Uint8Array, width: number, x: number, y: number): number {
  let xx = 0, xy = 0, yy = 0;
  for (let row = -2; row <= 2; row++) {
    for (let col = -2; col <= 2; col++) {
      const i = (y + row) * width + x + col;
      const gx = (image[i + 1] - image[i - 1]) / 2;
      const gy = (image[i + width] - image[i - width]) / 2;
      xx += gx * gx; xy += gx * gy; yy += gy * gy;
    }
  }
  return (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / 50;
}

export function estimateFlow(previous: Uint8Array, current: Uint8Array, width: number, height: number): FlowResult {
  const empty = (message: string, features = 0, matches = 0): FlowResult => ({ dx: 0, dy: 0, quality: 0, features, matches, message });
  if (previous.length !== width * height || current.length !== width * height) return empty('Waiting for a complete camera frame.');
  const candidates: { x: number; y: number; score: number }[] = [];
  const margin = SEARCH + PATCH + 3;
  for (let y = margin; y < height - margin; y += 12) {
    for (let x = margin; x < width - margin; x += 12) {
      const score = cornerScore(previous, width, x, y);
      if (score >= 18) candidates.push({ x, y, score });
    }
  }
  // One candidate per grid cell; keep enough distributed features to reject
  // isolated objects and ambiguous edges without processing the full image.
  const points = candidates.sort((a, b) => b.score - a.score).slice(0, 24);
  if (points.length < 6) return empty('Not enough texture. Aim at printed paper or a patterned surface.', points.length);

  const vectors: { x: number; y: number; px: number; py: number }[] = [];
  for (const point of points) {
    const patch: number[] = [];
    for (let row = -PATCH; row <= PATCH; row++) {
      for (let col = -PATCH; col <= PATCH; col++) patch.push(previous[(point.y + row) * width + point.x + col]);
    }
    const cost = (dx: number, dy: number): number => {
      let sum = 0, square = 0, index = 0;
      for (let row = -PATCH; row <= PATCH; row++) {
        for (let col = -PATCH; col <= PATCH; col++) {
          const difference = patch[index++] - current[(point.y + row + dy) * width + point.x + col + dx];
          sum += difference; square += difference * difference;
        }
      }
      // Remove patch mean brightness difference, tolerating modest exposure changes.
      return Math.max(0, square / patch.length - (sum / patch.length) ** 2);
    };
    let best = Infinity, bx = 0, by = 0;
    const scores: { x: number; y: number; score: number }[] = [];
    for (let dy = -SEARCH; dy <= SEARCH; dy++) {
      for (let dx = -SEARCH; dx <= SEARCH; dx++) {
        const score = cost(dx, dy);
        scores.push({ x: dx, y: dy, score });
        if (score < best) { best = score; bx = dx; by = dy; }
      }
    }
    if (Math.abs(bx) === SEARCH || Math.abs(by) === SEARCH || best > 225) continue;
    let alternative = Infinity;
    for (const match of scores) {
      if (Math.max(Math.abs(match.x - bx), Math.abs(match.y - by)) > 2) alternative = Math.min(alternative, match.score);
    }
    if (alternative < best * 1.15 + 2) continue;
    const refine = (left: number, right: number): number => {
      const denominator = left - 2 * best + right;
      return denominator > 0.001 ? Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator)) : 0;
    };
    vectors.push({ x: bx + refine(cost(bx - 1, by), cost(bx + 1, by)),
      y: by + refine(cost(bx, by - 1), cost(bx, by + 1)), px: point.x, py: point.y });
  }
  if (vectors.length < 6) return empty('Image matching lost. Move more slowly; improve light and focus.', points.length, vectors.length);
  const mx = median(vectors.map(value => value.x)), my = median(vectors.map(value => value.y));
  const inliers = vectors.filter(value => Math.hypot(value.x - mx, value.y - my) <= 1.25);
  const quality = inliers.length / points.length;
  if (inliers.length < 6 || quality < 0.6) return empty('Scene motion is inconsistent. Keep the phone level and the scene still.', points.length, inliers.length);
  const xs = inliers.map(value => value.px), ys = inliers.map(value => value.py);
  if (Math.max(...xs) - Math.min(...xs) < width * 0.25 || Math.max(...ys) - Math.min(...ys) < height * 0.25) {
    return empty('Spread texture across the view; avoid tracking just one small object.', points.length, inliers.length);
  }
  const dx = median(inliers.map(value => value.x)), dy = median(inliers.map(value => value.y));
  return { dx: Math.abs(dx) < 0.12 ? 0 : dx, dy: Math.abs(dy) < 0.12 ? 0 : dy,
    quality, features: points.length, matches: inliers.length, message: 'Visual tracking ready. Keep the phone parallel to the surface.' };
}
