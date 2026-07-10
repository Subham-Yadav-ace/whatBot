'use strict';

const dayjs = require('dayjs');

/**
 * Fields we care about for change detection.
 * Cosmetic-only portal edits won't touch these, so we don't spam the group.
 */
const TRACKED_FIELDS = [
  'deadline',
  'eligibleBranches',
  'eligibleBatches',
  'minCGPA',
  'maxBacklogs',
  'packageOrStipend',
  'importantInstructions',
];

const FIELD_LABELS = {
  deadline: 'Deadline',
  eligibleBranches: 'Eligible Branches',
  eligibleBatches: 'Eligible Batches',
  minCGPA: 'Min CGPA',
  maxBacklogs: 'Max Backlogs',
  packageOrStipend: 'Package/Stipend',
  importantInstructions: 'Instructions',
};

function formatValue(field, val) {
  if (val === null || val === undefined || val === '') return '—';
  if (field === 'deadline') return dayjs(val).format('DD MMM YYYY');
  if (Array.isArray(val)) return val.length === 0 ? '—' : val.join(', ');
  return String(val);
}

/**
 * Compare previousSummary vs newSummary across tracked fields.
 * @returns {{ hasChanges: boolean, lines: string[] }}
 */
function diffSummary(previous, current) {
  if (!previous) return { hasChanges: false, lines: [] };

  const lines = [];
  for (const field of TRACKED_FIELDS) {
    const oldStr = formatValue(field, previous[field]);
    const newStr = formatValue(field, current[field]);
    if (oldStr !== newStr) {
      lines.push(`• ${FIELD_LABELS[field]}: ${oldStr} → ${newStr}`);
    }
  }

  return { hasChanges: lines.length > 0, lines };
}

module.exports = { diffSummary };
