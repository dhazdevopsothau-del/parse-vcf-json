// vcf2json.js
"use strict";

const fs = require("fs");
const path = require("path");

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

/** VCF line-folding: a continuation line starts with SP or TAB */
function unfoldLines(text) {
  return text
    .replace(/\r\n/g, "\n") // normalize CRLF → LF
    .replace(/\n[ \t]/g, ""); // unfold: remove newline + leading whitespace
}

/**
 * Unescape VCF property values.
 * Order matters: \\ must be last to avoid double-unescaping.
 */
function unescapeVcf(str) {
  if (!str) return str;
  return str
    .replace(/\\n/gi, "\n") // \n  → real newline
    .replace(/\\:/g, ":") // \:  → :
    .replace(/\\\//g, "/") // \/  → /
    .replace(/\\\\/g, "\\"); // \\  → \
}

/**
 * Parse the parameter portion of a VCF property line.
 * Input example: "TYPE=INTERNET;TYPE=HOME" or "TYPE=INTERNET,HOME"
 * Returns { types: string[], label: string|null }
 */
function parseParams(paramStr) {
  const types = [];
  let label = null;

  if (!paramStr) return { types, label };

  const parts = paramStr.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;

    const pKey = part.slice(0, eqIdx).trim().toUpperCase();
    const pVal = part.slice(eqIdx + 1).trim();

    if (pKey === "TYPE") {
      // Handle both TYPE=A,B (vCard 4.0) and multiple TYPE= segments
      for (const t of pVal.split(",")) {
        const upper = t.trim().toUpperCase();
        if (upper) types.push(upper);
      }
    } else if (pKey === "LABEL") {
      label = pVal;
    }
    // other params (ENCODING, CHARSET, etc.) are intentionally ignored
    // since we only need TYPE for the output spec
  }

  return { types, label };
}

/**
 * Parse the ADR value (semicolon-separated).
 * vCard ADR field: poBox;extended;street;city;state;postalCode;country
 */
function parseAdr(value) {
  const parts = value.split(";");
  return {
    poBox: unescapeVcf(parts[0] || ""),
    extended: unescapeVcf(parts[1] || ""),
    street: unescapeVcf(parts[2] || ""),
    city: unescapeVcf(parts[3] || ""),
    state: unescapeVcf(parts[4] || ""),
    postalCode: unescapeVcf(parts[5] || ""),
    country: unescapeVcf(parts[6] || ""),
  };
}

/**
 * Parse the N (name) value (semicolon-separated).
 * vCard N field: family;given;additional;prefix;suffix
 */
function parseName(value) {
  const parts = value.split(";");
  return {
    family: unescapeVcf(parts[0] || ""),
    given: unescapeVcf(parts[1] || ""),
    additional: unescapeVcf(parts[2] || ""),
    prefix: unescapeVcf(parts[3] || ""),
    suffix: unescapeVcf(parts[4] || ""),
  };
}

/**
 * Parse the NOTE field into a userDefined key-value object.
 *
 * The NOTE value uses literal \n (backslash + n) as line separator.
 * Each line looks like: "key: value"
 *
 * Rules:
 *  - Unescape \n → real newline, \: → :, \/ → /
 *  - Split on real newlines
 *  - Find first ": " to split key / value
 *  - Duplicate keys → array, then deduplicate
 *  - Single-element array after dedup → back to string
 *  - Keep original key name as-is
 */
function parseNote(noteValue) {
  if (!noteValue) return {};

  // Unescape the NOTE value (literal \n becomes real newline, etc.)
  const unescaped = unescapeVcf(noteValue);
  const lines = unescaped.split("\n");
  const result = {};

  for (const line of lines) {
    const sepIdx = line.indexOf(": ");
    if (sepIdx === -1) continue; // fallback: skip malformed lines

    const key = line.slice(0, sepIdx).trim();
    const val = line.slice(sepIdx + 2).trim();

    if (!key) continue;

    if (Object.prototype.hasOwnProperty.call(result, key)) {
      if (Array.isArray(result[key])) {
        result[key].push(val);
      } else {
        result[key] = [result[key], val];
      }
    } else {
      result[key] = val;
    }
  }

  // Deduplicate arrays; collapse single-element arrays to string
  for (const key of Object.keys(result)) {
    if (Array.isArray(result[key])) {
      const deduped = [...new Set(result[key])];
      result[key] = deduped.length === 1 ? deduped[0] : deduped;
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
//  CORE PARSER
// ══════════════════════════════════════════════════════════════

/**
 * Split a raw VCF property line into its components.
 * Format: [item<N>.]PROPERTY[;PARAM1=V1;PARAM2=V2]:value
 *
 * Returns: { itemPrefix, propName, paramStr, value }
 */
function splitVcfLine(line) {
  // 1. Separate name+params from value at the FIRST unescaped ':'
  let colonIdx = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ":" && (i === 0 || line[i - 1] !== "\\")) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx === -1) return null;

  const namePart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  // 2. Split name part at first ';' to separate property name from params
  const semiIdx = namePart.indexOf(";");
  const fullName = semiIdx === -1 ? namePart : namePart.slice(0, semiIdx);
  const paramStr = semiIdx === -1 ? "" : namePart.slice(semiIdx + 1);

  // 3. Detect item-prefix pattern (item1.PROPNAME)
  const dotIdx = fullName.indexOf(".");
  const itemPrefix = dotIdx !== -1 ? fullName.slice(0, dotIdx) : null;
  const propName = dotIdx !== -1 ? fullName.slice(dotIdx + 1) : fullName;

  return { itemPrefix, propName: propName.toUpperCase(), paramStr, value };
}

/**
 * Parse one BEGIN:VCARD … END:VCARD block into { contact, userDefined }.
 */
function parseVcard(block) {
  const lines = block.split("\n").filter((l) => l.trim() !== "");

  // ── First pass: collect raw items ───────────────────────────
  // We need item-prefix grouping for X-ABLABEL support
  // itemMap: { "item1" → { propName, paramStr, value, types }[] }
  const itemMap = {}; // prefix → array of parsed items
  const rawLines = []; // { itemPrefix, propName, paramStr, value } for all lines

  for (const line of lines) {
    if (/^BEGIN:VCARD$/i.test(line) || /^END:VCARD$/i.test(line)) continue;
    if (/^VERSION:/i.test(line)) continue;

    const parsed = splitVcfLine(line);
    if (!parsed) continue;
    rawLines.push(parsed);

    if (parsed.itemPrefix) {
      if (!itemMap[parsed.itemPrefix]) itemMap[parsed.itemPrefix] = [];
      itemMap[parsed.itemPrefix].push(parsed);
    }
  }

  // ── Build label lookup from X-ABLABEL ────────────────────────
  // labelLookup: { "item1" → "Work Label" }
  const labelLookup = {};
  for (const [prefix, items] of Object.entries(itemMap)) {
    for (const item of items) {
      if (item.propName === "X-ABLABEL") {
        labelLookup[prefix] = item.value
          .replace(/^_\$!</, "") // strip Google's _$!< prefix
          .replace(/>!\$_$/, ""); // strip Google's >!$_ suffix
      }
    }
  }

  // ── Second pass: build contact object ────────────────────────
  const contact = {
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    dates: [],
    extensions: {},
  };
  let noteValue = null;

  for (const { itemPrefix, propName, paramStr, value } of rawLines) {
    const { types } = parseParams(paramStr);
    const label = itemPrefix ? labelLookup[itemPrefix] || null : null;

    switch (propName) {
      case "FN":
        contact.displayName = unescapeVcf(value);
        break;

      case "N":
        contact.name = parseName(value);
        break;

      case "EMAIL": {
        const entry = { type: types, value: unescapeVcf(value) };
        if (label) entry.label = label;
        contact.emails.push(entry);
        break;
      }

      case "TEL": {
        const entry = { type: types, value: unescapeVcf(value) };
        if (label) entry.label = label;
        contact.phones.push(entry);
        break;
      }

      case "ADR": {
        const entry = { type: types, value: parseAdr(value) };
        if (label) entry.label = label;
        contact.addresses.push(entry);
        break;
      }

      case "URL": {
        const entry = { type: types, value: unescapeVcf(value) };
        if (label) entry.label = label;
        contact.urls.push(entry);
        break;
      }

      case "BDAY":
        contact.birthday = value;
        break;

      case "ANNIVERSARY":
        contact.anniversary = value;
        break;

      case "ORG":
        contact.organization = unescapeVcf(value.split(";")[0]);
        break;

      case "TITLE":
        contact.title = unescapeVcf(value);
        break;

      case "NOTE":
        // Collect full NOTE value; will be parsed into userDefined after loop
        noteValue = value;
        break;

      case "PHOTO":
        contact.photo = value;
        break;

      case "UID":
        contact.uid = value;
        break;

      case "REV":
        contact.rev = value;
        break;

      case "CATEGORIES":
        contact.categories = value.split(",").map((c) => unescapeVcf(c.trim()));
        break;

      case "X-ABLABEL":
        // Already handled via labelLookup — skip
        break;

      case "X-ABDATE": {
        // Check if this is an Anniversary label
        const ablabel = itemPrefix ? labelLookup[itemPrefix] : null;
        if (ablabel && /anniversary/i.test(ablabel)) {
          contact.anniversary = value;
        } else {
          contact.dates.push({ label: ablabel || null, value });
        }
        break;
      }

      default:
        // All other X-* fields and unrecognised standard fields → extensions
        if (propName.startsWith("X-")) {
          if (Object.prototype.hasOwnProperty.call(contact.extensions, propName)) {
            const existing = contact.extensions[propName];
            if (Array.isArray(existing)) {
              existing.push(unescapeVcf(value));
            } else {
              contact.extensions[propName] = [existing, unescapeVcf(value)];
            }
          } else {
            contact.extensions[propName] = unescapeVcf(value);
          }
        }
        // Known vCard fields not in spec table are silently ignored
        break;
    }
  }

  // ── Clean up empty arrays / objects ──────────────────────────
  if (contact.emails.length === 0) delete contact.emails;
  if (contact.phones.length === 0) delete contact.phones;
  if (contact.addresses.length === 0) delete contact.addresses;
  if (contact.urls.length === 0) delete contact.urls;
  if (contact.dates.length === 0) delete contact.dates;
  if (Object.keys(contact.extensions).length === 0) delete contact.extensions;

  // ── Parse NOTE → userDefined ──────────────────────────────────
  const userDefined = noteValue ? parseNote(noteValue) : {};

  return { contact, userDefined };
}

/**
 * Read a .vcf file and return an array of parsed vCard objects.
 */
function parseVcf(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`❌ Cannot read file: ${err.message}`);
    process.exit(1);
  }

  const unfolded = unfoldLines(raw);

  // Extract all BEGIN:VCARD … END:VCARD blocks (case-insensitive)
  const blockRegex = /BEGIN:VCARD[\s\S]*?END:VCARD/gi;
  const blocks = unfolded.match(blockRegex);

  if (!blocks || blocks.length === 0) {
    console.warn("⚠️  No VCARD block found in the file.");
    return [];
  }

  return blocks.map((block) => parseVcard(block));
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node vcf2json.js <input.vcf> [output.json]");
  process.exit(1);
}

const outputPath = process.argv[3] || path.join(path.dirname(path.resolve(inputPath)), path.basename(inputPath, path.extname(inputPath)) + ".json");

try {
  const results = parseVcf(inputPath);
  const output = results.length === 1 ? results[0] : results;

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`✅ Converted ${results.length} contact(s) → ${outputPath}`);
} catch (err) {
  console.error(`❌ Unexpected error: ${err.message}`);
  process.exit(1);
}
