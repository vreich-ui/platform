#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import yaml from 'js-yaml';
import sharp from 'sharp';

const defaultUploadRoot = 'src/assets/images/uploads';
const defaultPostRoot = 'src/data/post';
const uploadAliasPrefix = '~/assets/images/uploads/';
const extensionFormat = new Map([
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.png', 'png'],
  ['.webp', 'webp'],
]);

const toPosixPath = (value) => value.split(path.sep).join('/');

const getExpectedFormat = (filePath) => extensionFormat.get(path.extname(filePath).toLowerCase());

export const collectUploadImageFiles = async (root = defaultUploadRoot) => {
  const files = [];

  const visit = async (directory) => {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && getExpectedFormat(entryPath)) {
        files.push(entryPath);
      }
    }
  };

  await visit(root);

  return files.sort((left, right) => left.localeCompare(right));
};

const collectMarkdownFiles = async (root = defaultPostRoot) => {
  const files = [];

  const visit = async (directory) => {
    let entries;

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        files.push(entryPath);
      }
    }
  };

  await visit(root);

  return files.sort((left, right) => left.localeCompare(right));
};

const splitFrontmatter = (content) => {
  if (!content.startsWith('---')) return { frontmatter: '', body: content };

  const end = content.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: content };

  const afterEnd = content.indexOf('\n', end + 1);

  return {
    frontmatter: content.slice(3, end).trim(),
    body: afterEnd === -1 ? '' : content.slice(afterEnd + 1),
  };
};

const normalizeReferencedUploadPath = (value) => {
  if (typeof value !== 'string' || !value.startsWith(uploadAliasPrefix)) return undefined;

  return value.split(/[?#]/, 1)[0];
};

export const collectMarkdownUploadImageReferences = async (postRoot = defaultPostRoot) => {
  const markdownFiles = await collectMarkdownFiles(postRoot);
  const references = [];
  const inlineImagePattern = /!\[[^\]]*\]\((?<path>[^)\s]+)(?:\s+['"][^)]*['"])?\)/g;

  for (const markdownFile of markdownFiles) {
    const content = await readFile(markdownFile, 'utf8');
    const { frontmatter, body } = splitFrontmatter(content);

    if (frontmatter) {
      const data = yaml.load(frontmatter);
      const imagePath = normalizeReferencedUploadPath(data?.image);
      if (imagePath) references.push({ markdownFile, imagePath, source: 'frontmatter image' });
    }

    for (const match of body.matchAll(inlineImagePattern)) {
      const imagePath = normalizeReferencedUploadPath(match.groups?.path);
      if (imagePath) references.push({ markdownFile, imagePath, source: 'inline image' });
    }
  }

  return references;
};

export const validateMarkdownUploadImageReferences = async ({
  uploadRoot = defaultUploadRoot,
  postRoot = defaultPostRoot,
} = {}) => {
  const references = await collectMarkdownUploadImageReferences(postRoot);
  const missing = [];

  for (const reference of references) {
    const relativeUploadPath = reference.imagePath.slice(uploadAliasPrefix.length);
    const resolvedPath = path.join(uploadRoot, relativeUploadPath);

    try {
      await access(resolvedPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;

      missing.push(
        `${toPosixPath(reference.markdownFile)}: missing ${reference.source} ${reference.imagePath} (expected ${toPosixPath(resolvedPath)}).`
      );
    }
  }

  return { references, missing };
};

export const validateUploadImageFile = async (filePath) => {
  const expectedFormat = getExpectedFormat(filePath);

  if (!expectedFormat) return undefined;

  let metadata;

  try {
    metadata = await sharp(filePath, { failOn: 'error' }).metadata();
  } catch {
    return `${toPosixPath(filePath)}: could not be decoded as a valid ${expectedFormat.toUpperCase()} image.`;
  }

  if (!metadata.width || metadata.width <= 0 || !metadata.height || metadata.height <= 0) {
    return `${toPosixPath(filePath)}: decoded image is missing positive width/height metadata.`;
  }

  if (metadata.format !== expectedFormat) {
    return `${toPosixPath(filePath)}: file extension expects ${expectedFormat}, but decoded format is ${metadata.format ?? 'unknown'}.`;
  }

  return undefined;
};

export const validateUploadImages = async (root = defaultUploadRoot, postRoot = defaultPostRoot) => {
  const files = await collectUploadImageFiles(root);
  const invalid = [];

  for (const file of files) {
    const issue = await validateUploadImageFile(file);
    if (issue) invalid.push(issue);
  }

  const { references, missing } = await validateMarkdownUploadImageReferences({ uploadRoot: root, postRoot });
  invalid.push(...missing);

  return { files, invalid, references };
};

const main = async () => {
  // T16.2: root/Dr-Lurie's legacy tree nests markdown posts under
  // `src/data/post` and their referenced images under
  // `src/assets/images/uploads` (the defaults below). Scaffolded tenants
  // (platform, fernwell, and every create-site genesis) do not carry that
  // `src/` legacy layout at all — their own build command must pass BOTH
  // roots explicitly (site-relative, since Netlify runs this with the
  // site's own directory as cwd) rather than relying on either default.
  const root = process.argv[2] || defaultUploadRoot;
  const postRoot = process.argv[3] || defaultPostRoot;
  const { files, invalid } = await validateUploadImages(root, postRoot);

  if (invalid.length) {
    for (const issue of invalid) console.error(issue);
    console.error(`Upload image validation failed: ${invalid.length} invalid image${invalid.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Upload image validation passed: ${files.length} image${files.length === 1 ? '' : 's'} checked.`);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
