import path from 'node:path';

// Files KHÔNG BAO GIỜ được sửa tự động
const FORBIDDEN_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.github\/.*\.ya?ml$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /poetry\.lock$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /\.env/,
  /secrets?\./i,
  /credentials?\./i,
  /^Dockerfile$/,
  /docker-compose/,
  /\.pem$/,
  /\.key$/,
];

const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt',
  '.rb', '.php',
  '.css', '.scss', '.html',
  '.json', '.md', // .json cẩn thận, đừng cho sửa package.json deps
]);

export function isFileSafeToModify(filePath: string): { ok: boolean; reason?: string } {
  const normalized = path.normalize(filePath).replace(/\\/g, '/');

  if (normalized.includes('..')) return { ok: false, reason: 'path traversal' };
  if (normalized.startsWith('/')) return { ok: false, reason: 'absolute path' };

  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(normalized)) return { ok: false, reason: `matches forbidden pattern ${re}` };
  }

  // package.json: chỉ cho sửa nếu KHÔNG đụng vào "dependencies"/"devDependencies"
  // (check thực tế làm trong applyFix step)

  const ext = path.extname(normalized);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `extension ${ext} not allowed` };
  }

  return { ok: true };
}

export const MAX_DIFF_LINES = 200;
export const MAX_FILES_PER_FIX = 5;
export const MAX_RETRY_ATTEMPTS = 3;
export const AUTO_MERGE_COOLDOWN_MINUTES = 30;

// Chỉ những loại lỗi này mới được auto-merge.
// Các lỗi logic phức tạp → tạo PR và đợi human review.
export const AUTO_MERGE_SAFE_ERROR_TYPES = new Set([
  'lint',
  'format',
  'prettier',
  'eslint',
  'TS2304', // Cannot find name (thường là missing import)
  'TS2307', // Cannot find module
  'TS6133', // unused variable
  'ImportError',
  'ModuleNotFoundError',
]);

export function canAutoMerge(errorTypes: string[]): boolean {
  return errorTypes.length > 0 && errorTypes.every(t => AUTO_MERGE_SAFE_ERROR_TYPES.has(t));
}
