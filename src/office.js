'use strict';

// Office 文档读写：docx / xlsx / pptx 都是 zip + xml，不依赖是否装了 Office。
const { readEntries, readEntry, getEntry, createZip } = require('./zip');

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── docx ──
function docxRead(buffer) {
  const entries = readEntries(buffer);
  const doc = getEntry(buffer, entries, 'word/document.xml');
  if (!doc) throw new Error('docx 里找不到 word/document.xml');
  const xml = doc.toString('utf8');
  const paragraphs = xml.split('</w:p>').map((chunk) => {
    const texts = [...chunk.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
    return texts.join('');
  });
  const kept = paragraphs.filter((p) => p.length > 0);
  const text = kept.join('\n');
  return { paragraphs: kept.length, text, length: text.length };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

function docxWrite(text) {
  const paragraphs = String(text)
    .split('\n')
    .map((line) => {
      const run = line.length === 0 ? '' : `<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
      return `<w:p>${run}</w:p>`;
    })
    .join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;
  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
  ]);
}

// ── xlsx ──
function xlsxRead(buffer) {
  const entries = readEntries(buffer);
  const sharedBuf = getEntry(buffer, entries, 'xl/sharedStrings.xml');
  const shared = sharedBuf
    ? [...sharedBuf.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''),
      )
    : [];

  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const sheets = sheetEntries.map((entry, index) => {
    const xml = readEntry(buffer, entry).toString('utf8');
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cellMatch[1] || '';
        const inner = cellMatch[2] || '';
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (type === 's' && value !== undefined) {
          cells.push(shared[Number(value)] ?? '');
        } else if (type === 'inlineStr') {
          cells.push([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(''));
        } else {
          cells.push(value === undefined ? '' : decodeXml(value));
        }
      }
      if (cells.length > 0) rows.push(cells);
    }
    return { index: index + 1, part: entry.name, rows };
  });

  return { sheets, rowCount: sheets.reduce((sum, s) => sum + s.rows.length, 0) };
}

// ── pptx ──
function pptxRead(buffer) {
  const entries = readEntries(buffer);
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

  const slides = slideEntries.map((entry, index) => {
    const xml = readEntry(buffer, entry).toString('utf8');
    const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1])).join('\n');
    return { index: index + 1, text };
  });

  return { slides, slideCount: slides.length };
}

// ── zip ──
function zipList(buffer) {
  return readEntries(buffer).map((e) => ({ name: e.name, size: e.size, compressed: e.compSize }));
}

module.exports = { docxRead, docxWrite, xlsxRead, pptxRead, zipList, decodeXml, escapeXml };
