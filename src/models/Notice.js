'use strict';

const mongoose = require('mongoose');

const summaryShape = {
  company: { type: String, default: '' },
  role: { type: String, default: '' },
  packageOrStipend: { type: String, default: '' },
  packageLPA: { type: Number, default: null },
  eligibleBranches: { type: [String], default: [] },
  eligibleBatches: { type: [String], default: [] },
  minCGPA: { type: Number, default: null },
  maxBacklogs: { type: Number, default: null },
  deadline: { type: Date, default: null },
  applyLink: { type: String, default: null },
  importantInstructions: { type: String, default: '' },
  hasShortlist: { type: Boolean, default: false },
  isInternship: { type: Boolean, default: false },
  isFollowUp: { type: Boolean, default: false },
};

const noticeSchema = new mongoose.Schema(
  {
    portalPostId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    rawBody: {
      type: String,
      default: '',
    },
    attachments: [
      {
        fileName: String,
        url: String,
      },
    ],

    // AI-extracted structured summary (current version)
    summary: {
      type: summaryShape,
      default: () => ({}),
    },

    // Snapshot BEFORE the most recent change — used for diffing
    previousSummary: {
      type: summaryShape,
      default: null,
    },

    portalCreatedAt: { type: String, default: '' },
    portalUpdatedAt: { type: String, default: '' },
    lastSyncedAt: { type: Date, default: null },

    // MD5 hash of (title + rawBody + attachments JSON).
    // Used for change detection — immune to portal's relative timestamp strings
    // like "1 day ago" → "2 days ago" that change without any real content update.
    contentHash: { type: String, default: null },

    // Notification guard timestamps — prevent duplicate sends
    notifiedNewAt: { type: Date, default: null },
    notifiedUpdateAt: { type: Date, default: null },

    // Set when a notice is queued as an admin-announcement job.
    // Prevents retryEmptySummaries from calling Gemini again every cycle
    // during the window between "job queued" and "worker processes it".
    pendingAdminAt: { type: Date, default: null },
  },
  {
    timestamps: true, // adds Mongoose createdAt / updatedAt
    collection: 'notices',
  }
);

// Indexes per plan.md section 6
noticeSchema.index({ portalCreatedAt: -1 });
noticeSchema.index({ 'summary.deadline': 1 });
noticeSchema.index({ 'summary.packageLPA': 1 });

const Notice = mongoose.model('Notice', noticeSchema);

module.exports = Notice;
