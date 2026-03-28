# PROMPT: VCF → JSON Converter (Node.js)

## [1] ROLE & CONTEXT

Bạn là một Node.js developer chuyên xử lý data transformation.  
Môi trường: Node.js (CommonJS hoặc ESM), không cần thư viện bên ngoài (chỉ dùng built-in `fs`, `path`).  
Mục tiêu: Parse file `.vcf` (vCard) chứa một hoặc nhiều contact, xuất ra file `.json` giữ nguyên toàn bộ thông tin.

---

## [2] TASK DEFINITION

**Nhiệm vụ:** Viết script Node.js đọc file `.vcf` đầu vào, parse từng VCARD block, và ghi kết quả ra file `.json`.

**IN SCOPE:**
- Parse tất cả fields tiêu chuẩn vCard 2.1 / 3.0 / 4.0
- Parse field `NOTE` chứa user-defined key-value (dạng `key: value\nkey: value`)
- Giữ nguyên tên field gốc — KHÔNG đổi tên, KHÔNG camelCase, KHÔNG remap
- Hỗ trợ multi-value (cùng key xuất hiện nhiều lần → array)
- Hỗ trợ VCF chứa nhiều contact (nhiều block `BEGIN:VCARD … END:VCARD`)
- Xuất file `output.json`

**OUT OF SCOPE:**
- Không validate dữ liệu
- Không upload lên API
- Không modify / sanitize giá trị

---

## [3] INPUT SPECIFICATION

- **Input:** Đường dẫn file `.vcf` truyền qua `process.argv[2]`  
  Ví dụ: `node vcf2json.js contacts.vcf`
- **Encoding:** UTF-8
- **Format VCF:** Có thể là CRLF (`\r\n`) hoặc LF (`\n`)
- **Line folding:** VCF cho phép xuống dòng bằng cách thêm khoảng trắng đầu dòng kế → phải unfold trước khi parse
- **Nếu không truyền đường dẫn:** In ra `Usage: node vcf2json.js <input.vcf>` rồi `process.exit(1)`
- **Nếu file không tồn tại:** Throw lỗi rõ ràng

---

## [4] STEP-BY-STEP INSTRUCTIONS

Thực hiện theo thứ tự sau, KHÔNG bỏ bước:

### Bước 1 — Đọc và Unfold file VCF

```
1. Đọc toàn bộ file dưới dạng UTF-8 string
2. Normalize line ending: thay \r\n → \n
3. Unfold lines: nếu dòng kế bắt đầu bằng SPACE hoặc TAB → nối vào dòng trước, bỏ ký tự đầu tiên (space/tab)
```

### Bước 2 — Tách thành các VCARD block

```
Tách toàn bộ nội dung thành mảng các block.
Mỗi block bắt đầu bằng BEGIN:VCARD và kết thúc bằng END:VCARD.
```

### Bước 3 — Parse từng VCARD block thành object

Với mỗi block, tạo object có cấu trúc:

```json
{
  "contact": { },
  "userDefined": { }
}
```

**3a — Parse các standard fields vào `contact`:**

| VCF Field | JSON key | Ghi chú |
|---|---|---|
| `FN` | `displayName` | string |
| `N` | `name` | object: `{ family, given, additional, prefix, suffix }` (split by `;`) |
| `EMAIL` | `emails` | array of `{ type: [...], value }` — lấy TYPE params |
| `TEL` | `phones` | array of `{ type: [...], value }` |
| `ADR` | `addresses` | array of `{ type: [...], value: { poBox, extended, street, city, state, postalCode, country } }` |
| `URL` | `urls` | array of `{ type: [...], value }` |
| `BDAY` | `birthday` | string gốc (ví dụ `20260223` hoặc `2026-02-23`) |
| `ANNIVERSARY` hoặc `X-ABDATE` với label Anniversary | `anniversary` | string gốc |
| `ORG` | `organization` | string |
| `TITLE` | `title` | string |
| `NOTE` | *(xử lý riêng — xem 3b)* | |
| `PHOTO` | `photo` | string (base64 hoặc URL) |
| `UID` | `uid` | string |
| `REV` | `rev` | string |
| `CATEGORIES` | `categories` | array (split by `,`) |
| `X-ABDATE` (không phải Anniversary) | vào `dates` | array of `{ label, value }` |
| `X-ABLABEL` | dùng để label item trước đó | xem ghi chú bên dưới |
| Các `X-*` field khác | vào `extensions` | object `{ "X-FIELDNAME": value }` |

**Ghi chú xử lý TYPE params:**
```
Dòng: EMAIL;TYPE=INTERNET;TYPE=HOME:foo@bar.com
→ { type: ["INTERNET", "HOME"], value: "foo@bar.com" }

Dòng: TEL;TYPE=CELL:0901234567
→ { type: ["CELL"], value: "0901234567" }

Nếu không có TYPE: { type: [], value: "..." }
```

**Ghi chú xử lý item label (X-ABLABEL pattern):**
```
VCF Google Contacts dùng pattern:
  item1.EMAIL;TYPE=INTERNET:foo@bar.com
  item1.X-ABLABEL:Work Label

→ Gán label "Work Label" vào item tương ứng (cùng prefix item1.)
→ Thêm field `label` vào object của item đó
```

**3b — Parse field `NOTE` vào `userDefined`:**

```
Nội dung NOTE dùng literal "\n" (backslash + n) làm separator dòng.
Mỗi dòng có dạng: "key: value"

Quy tắc parse:
1. Unescape: thay \n → newline thật, \: → :, \/ → /
2. Split theo newline thật
3. Với mỗi dòng: tìm ": " đầu tiên, lấy phần trước làm key, phần sau làm value
4. Trim key và value
5. Nếu key đã tồn tại trong userDefined:
   - Nếu value hiện tại là string → chuyển thành array [existingValue, newValue]
   - Nếu đã là array → push thêm newValue
6. Sau khi xong: deduplicate mỗi array (xóa phần tử trùng)
7. Nếu array chỉ còn 1 phần tử sau dedup → chuyển lại thành string
8. GIỮ NGUYÊN tên key gốc, KHÔNG đổi tên
```

**Ví dụ NOTE parse:**
```
Input NOTE value:
  go.2Fa.Secret: abc123\ngo.2Fa.passapp: pass1\ngo.2Fa.passapp: pass2

Output userDefined:
{
  "go.2Fa.Secret": "abc123",
  "go.2Fa.passapp": ["pass1", "pass2"]
}
```

### Bước 4 — Xử lý output array cho contact

Với mỗi field có thể xuất hiện nhiều lần (`EMAIL`, `TEL`, `ADR`, `URL`):
- Luôn lưu dưới dạng **array**, dù chỉ có 1 phần tử

### Bước 5 — Ghi file JSON

```
- Nếu VCF có 1 contact → output là object { contact, userDefined }
- Nếu VCF có nhiều contact → output là array [ { contact, userDefined }, ... ]
- Dùng JSON.stringify(result, null, 2)
- Ghi ra file cùng thư mục với input, đổi đuôi thành .json
  (hoặc nhận tham số output qua process.argv[3] nếu có)
- In ra console: "✅ Converted X contact(s) → output.json"
```

---

## [5] OUTPUT FORMAT

### Cấu trúc JSON một contact:

```json
{
  "contact": {
    "displayName": "John Doe",
    "name": {
      "family": "Doe",
      "given": "John",
      "additional": "",
      "prefix": "",
      "suffix": ""
    },
    "emails": [
      { "type": ["INTERNET", "HOME"], "value": "john@gmail.com" },
      { "type": ["INTERNET", "WORK"], "label": "Office", "value": "john@company.com" }
    ],
    "phones": [
      { "type": ["CELL"], "value": "0901234567" }
    ],
    "addresses": [
      {
        "type": ["HOME"],
        "value": {
          "poBox": "",
          "extended": "",
          "street": "123 Main St",
          "city": "Ho Chi Minh",
          "state": "",
          "postalCode": "70000",
          "country": "Vietnam"
        }
      }
    ],
    "urls": [
      { "type": [], "value": "https://example.com" }
    ],
    "birthday": "19900115",
    "anniversary": "--0423",
    "organization": "ACME Corp",
    "title": "Developer",
    "categories": ["myContacts", "friends"],
    "photo": "https://...",
    "uid": "abc-123",
    "rev": "2024-01-01T00:00:00Z",
    "dates": [
      { "label": "Anniversary", "value": "--0423" }
    ],
    "extensions": {
      "X-CUSTOM-FIELD": "value"
    }
  },
  "userDefined": {
    "go.2Fa.Secret": "svvyitqtytdqkzcv5mbtimvxkl7qu7dk",
    "go.2Fa.AuthLink": "otpauth://totp/Google:foo@gmail.com?secret=...",
    "go.2Fa.BackupCode": "1234 5678 9012",
    "go.2Fa.passapp": [
      "envd wypp ybqo oczz",
      "mpiq ihci kbpy khtw"
    ],
    "github.token": "ghp_xxx",
    "tailscale.com.TrustCredentials": [
      "clientId: xxx -- secretId: yyy",
      "clientId: aaa -- secretId: bbb"
    ]
  }
}
```

### Cấu trúc JSON nhiều contact:

```json
[
  { "contact": { ... }, "userDefined": { ... } },
  { "contact": { ... }, "userDefined": { ... } }
]
```

---

## [6] CONSTRAINTS & RULES

- ✅ LUÔN giữ nguyên tên key gốc trong `userDefined` (ví dụ: `go.2Fa.Secret`, `tailscale.com.dns`)
- ✅ LUÔN unfold lines trước khi parse (VCF line folding)
- ✅ LUÔN unescape giá trị VCF: `\n` → newline, `\:` → `:`, `\/` → `/`, `\\` → `\`
- ✅ LUÔN parse TYPE params thành array
- ✅ Nếu cùng key trong NOTE xuất hiện nhiều lần → array, deduplicate
- ✅ Field `emails`, `phones`, `addresses`, `urls` luôn là array
- 🚫 KHÔNG rename field trong `userDefined`
- 🚫 KHÔNG bỏ sót bất kỳ field nào trong VCF
- 🚫 KHÔNG thêm field không có trong data gốc
- 🚫 KHÔNG dùng thư viện bên ngoài (chỉ Node.js built-in)
- ⚠️ NẾU một field không thuộc standard vCard và không nằm trong NOTE → đưa vào `extensions`
- ⚠️ NẾU NOTE không có nội dung key-value → `userDefined` là object rỗng `{}`
- ⚠️ NẾU VCF rỗng hoặc không có block VCARD nào → in warning, xuất array rỗng `[]`

---

## [7] FALLBACK LOGIC

| Tình huống | Xử lý |
|---|---|
| File không tồn tại | `console.error("❌ File not found: " + inputPath)` rồi `process.exit(1)` |
| VCF không có BEGIN:VCARD | `console.warn("⚠️ No VCARD block found")`, xuất `[]` |
| Dòng trong NOTE không có `: ` | Bỏ qua dòng đó |
| Field `N` thiếu segments | Điền `""` cho phần thiếu |
| `BDAY` format lạ (không phải YYYYMMDD hay YYYY-MM-DD) | Giữ nguyên string gốc |
| `X-ABDATE` không có label tương ứng | Dùng `label: null` |
| Encoding lỗi | Bọc toàn bộ trong try/catch, in lỗi rõ ràng |

---

## [8] CODE SKELETON (Bắt buộc tuân theo cấu trúc)

```js
// vcf2json.js
const fs = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────
function unfoldLines(text) { /* ... */ }
function parseParams(paramStr) { /* trả về { types: [], label: null } */ }
function unescapeVcf(str) { /* \n \: \/ \\ */ }
function parseNote(noteValue) { /* → object userDefined */ }
function parseAdr(value) { /* → { poBox, extended, street, city, state, postalCode, country } */ }
function parseName(value) { /* → { family, given, additional, prefix, suffix } */ }

// ── Core parser ───────────────────────────────────────────
function parseVcard(block) {
  const contact = {};
  const userDefined = {};
  // parse lines...
  return { contact, userDefined };
}

function parseVcf(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const unfolded = unfoldLines(raw);
  // tách blocks, parse từng block
  // return array
}

// ── Main ─────────────────────────────────────────────────
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node vcf2json.js <input.vcf> [output.json]');
  process.exit(1);
}

const outputPath = process.argv[3] 
  || path.join(path.dirname(inputPath), path.basename(inputPath, '.vcf') + '.json');

const results = parseVcf(inputPath);
const output = results.length === 1 ? results[0] : results;

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(`✅ Converted ${results.length} contact(s) → ${outputPath}`);
```

---

## Lưu ý khi implement

1. **item-prefix pattern** (Google Contacts hay dùng):
   ```
   item1.EMAIL;TYPE=INTERNET:foo@bar.com
   item1.X-ABLABEL:Nhà riêng
   ```
   → Cần group theo prefix `item1.`, gắn label vào đúng field

2. **NOTE multi-line unescape:** literal `\n` trong VCF (2 ký tự backslash+n) khác với newline thật — phải replace `\\n` → `\n` trước khi split

3. **Dedup array:** Dùng `[...new Set(arr)]` hoặc filter indexOf

4. **TYPE có thể viết nhiều cách:**
   - `TYPE=INTERNET;TYPE=HOME` (vCard 3.0)
   - `TYPE=INTERNET,HOME` (vCard 4.0)
   → Cần handle cả hai

5. **Test với file VCF thật** sau khi code xong bằng lệnh:
   ```bash
   node vcf2json.js contacts.vcf
   cat contacts.json | head -50
   ```
