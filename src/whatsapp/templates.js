'use strict';

const dayjs = require('dayjs');

function fmt(date) {
  if (!date) return null;
  return dayjs(date).format('DD MMM YYYY');
}

/**
 * New placement drive / internship notification.
 */
function formatNewDrive(notice) {
  const s = notice.summary;
  const lines = [];

  lines.push(s.isInternship ? '🎯 NEW INTERNSHIP DRIVE' : '🚀 NEW PLACEMENT DRIVE');
  lines.push('');
  lines.push(`🏢 Company: ${s.company || '—'}`);
  lines.push(`💼 Role: ${s.role || '—'}`);
  if (s.packageOrStipend) lines.push(`💰 Package/Stipend: ${s.packageOrStipend}`);
  if (s.eligibleBranches?.length) lines.push(`🎓 Eligible: ${s.eligibleBranches.join(', ')}`);
  if (s.eligibleBatches?.length) lines.push(`📅 Batch: ${s.eligibleBatches.join(', ')}`);
  if (s.minCGPA != null) lines.push(`📊 CGPA: ${s.minCGPA}+`);
  if (s.maxBacklogs != null) lines.push(`📋 Max Backlogs: ${s.maxBacklogs}`);
  if (s.deadline) {
    lines.push('');
    lines.push(`⏰ Deadline: ${fmt(s.deadline)}`);
  }
  if (s.importantInstructions) {
    lines.push('');
    lines.push(`📝 ${s.importantInstructions}`);
  }
  if (s.applyLink) {
    lines.push('');
    lines.push(`🔗 Apply Link:\n${s.applyLink}`);
  }
  if (notice.attachments?.length) {
    lines.push('');
    lines.push(`📎 Attachments: ${notice.attachments.map((a) => a.fileName).join(', ')}`);
  }
  const tag = (s.company || 'Placement').replace(/\s+/g, '');
  lines.push('');
  lines.push(`#Placement #${tag}`);

  return lines.join('\n');
}

/**
 * Notice was updated with meaningful field changes.
 */
function formatNoticeUpdated(notice, diffLines) {
  const s = notice.summary;
  const lines = [];

  lines.push('🔄 PLACEMENT NOTICE UPDATED');
  lines.push('');
  lines.push(`🏢 Company: ${s.company || '—'}`);
  lines.push(`💼 Role: ${s.role || '—'}`);
  lines.push('');
  lines.push('Changes:');
  (diffLines || []).forEach((l) => lines.push(l));
  if (s.applyLink) {
    lines.push('');
    lines.push(`🔗 Apply Link:\n${s.applyLink}`);
  }

  return lines.join('\n');
}

/**
 * 24-hour deadline reminder.
 */
function formatDeadlineReminder(notice) {
  const s = notice.summary;
  const lines = [];

  lines.push('⏰ DEADLINE REMINDER');
  lines.push('');
  lines.push(`🏢 Company: ${s.company || '—'}`);
  lines.push(`💼 Role: ${s.role || '—'}`);
  lines.push(`📅 Deadline: ${fmt(s.deadline)}`);
  if (s.applyLink) {
    lines.push('');
    lines.push(`🔗 Apply now:\n${s.applyLink}`);
  }

  return lines.join('\n');
}

/**
 * Same-day final reminder.
 */
function formatFinalReminder(notice) {
  const s = notice.summary;
  const lines = [];

  lines.push('⚠️ FINAL REMINDER — CLOSES TODAY');
  lines.push('');
  lines.push(`🏢 Company: ${s.company || '—'}`);
  lines.push(`💼 Role: ${s.role || '—'}`);
  lines.push(`📅 Deadline: ${fmt(s.deadline)}`);
  if (s.applyLink) {
    lines.push('');
    lines.push(`🔗 Apply now:\n${s.applyLink}`);
  }

  return lines.join('\n');
}

/**
 * Morning daily digest.
 */
function formatDailyDigest(newDrives, upcomingDeadlines) {
  const lines = [];

  lines.push('📰 DAILY PLACEMENT DIGEST');
  lines.push(dayjs().format('DD MMM YYYY'));
  lines.push('');

  if (newDrives.length === 0 && upcomingDeadlines.length === 0) {
    lines.push('No new drives or upcoming deadlines today.');
    return lines.join('\n');
  }

  if (newDrives.length > 0) {
    lines.push(`New Drives (${newDrives.length}):`);
    newDrives.forEach((n) => {
      lines.push(`• ${n.summary.company} — ${n.summary.role}`);
    });
  }

  if (upcomingDeadlines.length > 0) {
    if (newDrives.length > 0) lines.push('');
    lines.push('Upcoming Deadlines:');
    upcomingDeadlines.forEach((n) => {
      lines.push(`• ${n.summary.company} — ${fmt(n.summary.deadline)}`);
    });
  }

  return lines.join('\n');
}

/**
 * Strip HTML tags from a string and produce readable plain text.
 */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')       // remove all remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')    // collapse excess blank lines
    .trim();
}

/**
 * Admin / office announcement (no company extracted by AI).
 * Sent once, no reminders.
 */
function formatAdminAnnouncement(notice) {
  const lines = [];

  lines.push('📢 PLACEMENT OFFICE ANNOUNCEMENT');
  lines.push('');
  lines.push(`📌 ${notice.title}`);
  lines.push('');

  if (notice.rawBody) {
    lines.push(stripHtml(notice.rawBody));
    lines.push('');
  }

  lines.push('#Placement #Notice');

  return lines.join('\n');
}

module.exports = {
  formatNewDrive,
  formatNoticeUpdated,
  formatAdminAnnouncement,
  formatDeadlineReminder,
  formatFinalReminder,
  formatDailyDigest,
};
