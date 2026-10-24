import { File, FileArchive, FileAxis3D, FileBox, FileBraces, FileChartColumn, FileCode, FileCog, FileDiff, FileImage, FileJson, FileKey, FileLock, FileMusic, FileSliders, FileSpreadsheet, FileTerminal, FileText, FileType, FileVideo, Database, type LucideIcon } from 'lucide-react';

// Same Lucide file families as Orca. Group mappings keep every surface consistent.
const groups: [LucideIcon, string][] = [
  [FileCode, 'astro c cc cjs clj cpp cs cts cxx dart erl ex exs fs fsx go h hpp hrl hs htm html java js jsx kt kts lua mjs mts nim php pl pm py r rb rs scala sol svelte swift ts tsx vb vue xhtml xml zig'],
  [FileType, 'css eot less otf sass scss ttf woff woff2'], [FileText, 'adoc doc docx log md mdx pdf qmd rmarkdown rmd rst rtf tex txt markdown'],
  [FileJson, 'json json5 jsonc'], [FileSliders, 'cfg conf hcl ini properties tf tfvars toml yaml yml'],
  [FileImage, 'ai avif bmp eps gif heic ico jpeg jpg png psd svg tif tiff webp'], [FileMusic, 'aac flac m4a mp3 ogg opus wav'],
  [FileVideo, 'avi m4v mkv mov mp4 mpeg mpg webm'], [FileArchive, '7z br bz2 dmg gz iso rar tar tbz2 tgz txz xz zip'],
  [FileAxis3D, 'blend fbx glb gltf obj stl'], [FileSpreadsheet, 'csv ods tsv xls xlsx'], [FileTerminal, 'bash bat cmd fish nu ps1 sh zsh'],
  [FileChartColumn, 'ipynb mmd ppt pptx'], [FileBraces, 'gql graphql proto'], [Database, 'db duckdb prisma sqlite sqlite3 sql'],
  [FileKey, 'asc cer crt gpg key pem pub'], [FileLock, 'lock p12 pfx'], [FileCog, 'gradle'],
];
const byExtension = new Map(groups.flatMap(([icon, extensions]) => extensions.split(' ').map(extension => [extension, icon] as const)));
const packages = new Set('bun.lock bun.lockb cargo.lock cargo.toml composer.json composer.lock gemfile go.mod go.sum package-lock.json package.json pipfile pnpm-lock.yaml pnpm-workspace.yaml poetry.lock pom.xml pyproject.toml requirements-dev.txt requirements.txt yarn.lock'.split(' '));
export function fileTypeIcon(path: string): LucideIcon {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (packages.has(name)) return FileBox;
  if (/^(license|notice|copying|codeowners)$/.test(name)) return FileKey;
  if (/^security(\.md)?$/.test(name) || /^\.env($|\.)/.test(name)) return FileLock;
  if (/^dockerfile($|\.)|^cmakelists\.txt$|^meson\.build$|^settings\.gradle/.test(name)) return FileCog;
  if (/^makefile($|\.)/.test(name)) return FileTerminal;
  if (/^(\.babelrc|\.dockerignore|\.editorconfig|\.eslintrc|\.gitattributes|\.gitignore|\.npmrc|\.prettierrc)$/.test(name) || /^(postcss|tailwind|vite|vitest)\.config\.|^tsconfig\.json$|^components\.json$|^\.(eslintrc|prettierrc)\.(js|cjs|yaml|yml)$/.test(name)) return FileSliders;
  if (/^(readme|authors|changelog|contributing|todo)$/.test(name)) return FileText;
  if (/\.tar\.(gz|xz|bz2)$/.test(name)) return FileArchive;
  return byExtension.get(name.split('.').pop() ?? '') ?? File;
}
export function FileTypeIcon({ path, size = 14,status }: { path: string; size?: number; status?:string }) {
  const Glyph = fileTypeIcon(path);
  return <Glyph size={size} aria-hidden="true" className="file-type-icon" data-git-status={status} strokeWidth={1.7} />;
}
