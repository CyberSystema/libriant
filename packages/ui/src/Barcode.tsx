import * as React from 'react';

/**
 * Self-contained Code 128 (subset B) barcode.
 *
 * Deliberately dependency-free — matching the camera scanner, which is a thin
 * wrapper over the native `BarcodeDetector` with no library. The encoder emits
 * the bar pattern as a binary string (1 = bar module, 0 = space module) which
 * the component draws as inline `<svg>` `<rect>`s. Because it's pure JSX with no
 * DOM/canvas, it renders SERVER-SIDE (so it works inside a print server
 * component) and is CSP-safe (real elements, not `dangerouslySetInnerHTML`).
 *
 * Subset B covers ASCII 32–126 — the alphanumeric copy/membership barcodes a
 * library uses. Values outside that range can't be encoded; the component then
 * degrades to just the human-readable text so a label still prints something.
 */

// Code 128 symbol patterns, indexed by symbol value 0–106. Each is the module
// bitmap for that symbol (bar/space runs); 0–102 are 11 modules, the Stop
// pattern (106) is 13. This is the canonical Code 128 table — do not edit a
// single bit or scanners will reject the output.
const CODE128_BARS: readonly string[] = [
  '11011001100',
  '11001101100',
  '11001100110',
  '10010011000',
  '10010001100',
  '10001001100',
  '10011001000',
  '10011000100',
  '10001100100',
  '11001001000',
  '11001000100',
  '11000100100',
  '10110011100',
  '10011011100',
  '10011001110',
  '10111001100',
  '10011101100',
  '10011100110',
  '11001110010',
  '11001011100',
  '11001001110',
  '11011100100',
  '11001110100',
  '11101101110',
  '11101001100',
  '11100101100',
  '11100100110',
  '11101100100',
  '11100110100',
  '11100110010',
  '11011011000',
  '11011000110',
  '11000110110',
  '10100011000',
  '10001011000',
  '10001000110',
  '10110001000',
  '10001101000',
  '10001100010',
  '11010001000',
  '11000101000',
  '11000100010',
  '10110111000',
  '10110001110',
  '10001101110',
  '10111011000',
  '10111000110',
  '10001110110',
  '11101110110',
  '11010001110',
  '11000101110',
  '11011101000',
  '11011100010',
  '11011101110',
  '11101011000',
  '11101000110',
  '11100010110',
  '11101101000',
  '11101100010',
  '11100011010',
  '11101111010',
  '11001000010',
  '11110001010',
  '10100110000',
  '10100001100',
  '10010110000',
  '10010000110',
  '10000101100',
  '10000100110',
  '10110010000',
  '10110000100',
  '10011010000',
  '10011000010',
  '10000110100',
  '10000110010',
  '11000010010',
  '11001010000',
  '11110111010',
  '11000010100',
  '10001111010',
  '10100111100',
  '10010111100',
  '10010011110',
  '10111100100',
  '10011110100',
  '10011110010',
  '11110100100',
  '11110010100',
  '11110010010',
  '11011011110',
  '11011110110',
  '11110110110',
  '10101111000',
  '10100011110',
  '10001011110',
  '10111101000',
  '10111100010',
  '11110101000',
  '11110100010',
  '10111011110',
  '10111101110',
  '11101011110',
  '11110101110',
  '11010000100',
  '11010010000',
  '11010011100',
  '1100011101011',
];
const START_B = 104;
const STOP = 106;

/**
 * Encode a string as a Code 128 (subset B) module bitmap (a string of '0'/'1').
 * Throws if the value is empty or contains a char outside ASCII 32–126.
 */
export function encodeCode128(value: string): string {
  if (value.length === 0) throw new Error('Code 128: empty value');
  let checksum = START_B;
  const symbols = [CODE128_BARS[START_B]];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code > 126) {
      throw new Error(`Code 128 (subset B) cannot encode char code ${code}`);
    }
    const symbolValue = code - 32;
    checksum += symbolValue * (i + 1);
    symbols.push(CODE128_BARS[symbolValue]);
  }
  symbols.push(CODE128_BARS[checksum % 103]);
  symbols.push(CODE128_BARS[STOP]);
  return symbols.join('');
}

type BarcodeProps = {
  value: string;
  /** Bar height in px (excludes the human-readable text row). */
  height?: number;
  /** Width of one barcode module in px. */
  moduleWidth?: number;
  /** Clear quiet-zone in px on each side (scanners need it). */
  quietZone?: number;
  /** Render the value as text under the bars. */
  showText?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export function Barcode({
  value,
  height = 56,
  moduleWidth = 2,
  quietZone = 12,
  showText = true,
  className,
  style,
}: BarcodeProps) {
  let binary: string | null = null;
  try {
    binary = encodeCode128(value);
  } catch {
    binary = null;
  }

  // Un-encodable value → at least show the text so the label is still useful.
  if (!binary) {
    return (
      <div className={className} style={{ fontFamily: 'monospace', ...style }}>
        {value}
      </div>
    );
  }

  // Collapse the bitmap into runs and keep only the black (bar) runs as rects.
  const bars: Array<{ x: number; w: number }> = [];
  let x = quietZone;
  for (let i = 0; i < binary.length; ) {
    let run = 1;
    while (i + run < binary.length && binary[i + run] === binary[i]) run++;
    if (binary[i] === '1') bars.push({ x, w: run * moduleWidth });
    x += run * moduleWidth;
    i += run;
  }
  const textRow = showText ? 18 : 0;
  const width = binary.length * moduleWidth + quietZone * 2;
  const totalHeight = height + textRow;

  return (
    <svg
      className={className}
      style={style}
      width={width}
      height={totalHeight}
      viewBox={`0 0 ${width} ${totalHeight}`}
      role="img"
      aria-label={value}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={width} height={totalHeight} fill="#fff" />
      {bars.map((b, idx) => (
        <rect key={idx} x={b.x} y={0} width={b.w} height={height} fill="#000" />
      ))}
      {showText ? (
        <text
          x={width / 2}
          y={totalHeight - 4}
          textAnchor="middle"
          fontFamily="monospace"
          fontSize="13"
          fill="#000"
        >
          {value}
        </text>
      ) : null}
    </svg>
  );
}
