'use strict';

const cheerio = require('cheerio');

/**
 * Clean up text content by removing excess whitespace and newlines.
 */
function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Convert a 2D array of data into a CSV string.
 */
function arrayToCsv(data) {
  return data
    .map((row) =>
      row
        .map((cell) => {
          // Escape quotes and wrap in quotes if there's a comma or newline
          const escaped = cell.replace(/"/g, '""');
          if (escaped.includes(',') || escaped.includes('\n')) {
            return `"${escaped}"`;
          }
          return escaped;
        })
        .join(',')
    )
    .join('\n');
}

/**
 * Parse an HTML body to find tables, and if found, return a synthetic
 * attachment object containing the CSV as a Base64 string.
 *
 * @param {string} rawBody The HTML string of the notice body.
 * @returns {object|null} The synthetic attachment, or null if no valid table.
 */
function extractTableToCsvAttachment(rawBody) {
  if (!rawBody) return null;

  const $ = cheerio.load(rawBody);
  const tables = $('table');

  if (tables.length === 0) return null;

  // For simplicity, we just take the first table we find.
  const table = tables.first();
  const rows = [];

  // Extract headers
  const headerRow = [];
  table.find('tr').first().find('th, td').each((_, el) => {
    headerRow.push(cleanText($(el).text()));
  });

  // Find the Name column index
  let nameColIdx = -1;
  headerRow.forEach((h, i) => {
    if (h.toLowerCase().includes('name')) {
      nameColIdx = i;
    }
  });

  // Fallback if 'name' not in header (e.g., S.No, Name, Branch)
  if (nameColIdx === -1 && headerRow.length > 1) {
    nameColIdx = 1;
  } else if (nameColIdx === -1) {
    nameColIdx = 0;
  }

  rows.push(['Student Name']);

  // Extract data rows
  table.find('tr').each((i, row) => {
    // Skip the first row if we already extracted it as headers
    if (i === 0 && headerRow.length > 0) return;

    const rowData = [];
    $(row).find('td').each((_, cell) => {
      rowData.push(cleanText($(cell).text()));
    });

    if (rowData.length > nameColIdx && rowData[nameColIdx]) {
      // Clean up the name string just in case
      const name = rowData[nameColIdx].replace(/^Mr\.\s*|^Ms\.\s*/i, '').trim();
      if (name && name.toLowerCase() !== 'student name' && name.toLowerCase() !== 'name') {
        rows.push([name]);
      }
    }
  });

  // If we couldn't parse at least 2 rows (header + data), it's probably not useful.
  if (rows.length < 2) return null;

  // Build CSV
  const csvString = arrayToCsv(rows);

  // Encode to Base64
  const base64Data = Buffer.from(csvString, 'utf-8').toString('base64');

  return {
    fileName: 'List.csv',
    base64Data,
    mimeType: 'text/csv',
  };
}

module.exports = { extractTableToCsvAttachment };
