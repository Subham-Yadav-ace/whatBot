'use strict';

const { GoogleGenAI } = require('@google/genai');
const env = require('../config/env');
const logger = require('../utils/logger').child({ module: 'aiSummary' });

const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

/**
 * JSON schema for the structured placement notice summary.
 * This is passed as responseSchema to enforce structured output from Gemini.
 */
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    role: { type: 'string' },
    packageOrStipend: { type: 'string', description: 'Human-readable, e.g. "12 LPA" or "₹80,000/month"' },
    packageLPA: {
      type: 'number',
      nullable: true,
      description: 'Numeric value in LPA only; null if not determinable or if internship stipend only',
    },
    eligibleBranches: {
      type: 'array',
      items: { type: 'string' },
      description: 'E.g. ["CSE", "IT", "ENTC"]',
    },
    eligibleBatches: {
      type: 'array',
      items: { type: 'string' },
      description: 'E.g. ["2025", "2026"]',
    },
    minCGPA: { type: 'number', nullable: true },
    maxBacklogs: { type: 'number', nullable: true },
    deadline: {
      type: 'string',
      nullable: true,
      description: 'ISO 8601 date string or null if not mentioned',
    },
    applyLink: { type: 'string', nullable: true },
    importantInstructions: {
      type: 'string',
      description: '1-3 sentences summarizing the most important instructions. Empty string if none.',
    },
    hasShortlist: {
      type: 'boolean',
      description: 'Set to true if the body contains a specific list or table of student names who are shortlisted, eligible, or selected. False otherwise.',
    },
    isInternship: { type: 'boolean' },
  },
  required: [
    'company',
    'role',
    'packageOrStipend',
    'packageLPA',
    'eligibleBranches',
    'eligibleBatches',
    'minCGPA',
    'maxBacklogs',
    'deadline',
    'applyLink',
    'importantInstructions',
    'isInternship',
  ],
};

/**
 * Build the extraction prompt for a given notice.
 */
function buildPrompt(title, rawBody) {
  return `You are extracting structured placement data from a college placement notice.

Title: ${title}

Notice Content (may be HTML):
${rawBody}

Instructions:
- Extract ONLY information explicitly stated in the text.
- NEVER invent values or make assumptions not supported by the text.
- Use null for numbers not mentioned, null for dates not mentioned, [] for arrays with no values, "" for strings not mentioned.
- For "deadline": extract the actual application deadline date (NOT a joining date or "within X weeks of joining"). Use ISO 8601 format. If ambiguous or not a clear calendar date, use null.
- For "packageLPA": extract ONLY the annual CTC in LPA as a number. For pure stipend internships where no LPA is given, use null.
- For "eligibleBranches": use short branch codes like CSE, IT, ENTC, MECH, CIVIL, etc.
- For "isInternship": true if the role is an internship or internship+PPO, false otherwise.
- Respond with ONLY the JSON object. No markdown, no explanation, no code fences.`;
}

/**
 * Extract a structured summary from a raw notice body using Gemini.
 *
 * @param {string} title  - The portal post title
 * @param {string} rawBody - The raw HTML/text body of the notice
 * @returns {object} Structured summary matching SUMMARY_SCHEMA
 */
/**
 * Parse the retry delay (in ms) from a Gemini 429 error response.
 * Returns 20000 (20s) as a safe default if parsing fails.
 */
function parseRetryDelay(err) {
  try {
    const body = JSON.parse(err.message);
    const retryInfo = body?.error?.details?.find(
      (d) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
    );
    if (retryInfo?.retryDelay) {
      // retryDelay is like "17s" or "17.923234888s"
      return Math.ceil(parseFloat(retryInfo.retryDelay) * 1000) + 1000;
    }
  } catch (_) {}
  return 20_000;
}

async function extractSummary(title, rawBody, _attempt = 1) {
  const MAX_ATTEMPTS = 3;

  if (!rawBody || rawBody.trim().length < 20) {
    logger.warn({ title }, 'Notice body too short for AI extraction — returning empty summary');
    return getEmptySummary();
  }

  logger.debug({ title, attempt: _attempt }, 'Calling Gemini for structured extraction...');

  try {
    const response = await ai.models.generateContent({
      model: env.geminiModel,
      contents: buildPrompt(title, rawBody),
      config: {
        responseMimeType: 'application/json',
        responseSchema: SUMMARY_SCHEMA,
        temperature: 0.1,
      },
    });

    const text = response.text;
    if (!text) throw new Error('Gemini returned empty response');

    const summary = JSON.parse(text);

    if (summary.deadline) {
      const parsed = new Date(summary.deadline);
      summary.deadline = isNaN(parsed.getTime()) ? null : parsed;
    }

    logger.info({ title, company: summary.company, role: summary.role }, 'AI extraction complete');
    return summary;
  } catch (err) {
    // Handle 429 rate limit with Gemini's suggested retry delay
    const is429 =
      err.message?.includes('429') ||
      err.message?.includes('RESOURCE_EXHAUSTED') ||
      err.message?.includes('quota');

    if (is429 && _attempt < MAX_ATTEMPTS) {
      const delayMs = parseRetryDelay(err);
      logger.warn(
        { title, attempt: _attempt, delayMs },
        `Gemini rate limit (429) — retrying in ${delayMs}ms...`
      );
      await new Promise((r) => setTimeout(r, delayMs));
      return extractSummary(title, rawBody, _attempt + 1);
    }

    logger.error({ err: err.message, title, attempt: _attempt }, 'AI extraction failed — returning empty summary');
    return getEmptySummary();
  }
}

/**
 * Returns a safe empty summary when extraction fails or body is missing.
 */
function getEmptySummary() {
  return {
    company: '',
    role: '',
    packageOrStipend: '',
    packageLPA: null,
    eligibleBranches: [],
    eligibleBatches: [],
    minCGPA: null,
    maxBacklogs: null,
    deadline: null,
    applyLink: null,
    importantInstructions: '',
    isInternship: false,
  };
}

module.exports = { extractSummary, getEmptySummary };
