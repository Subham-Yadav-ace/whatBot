# AIT Placement Bot (Interview Overview)

## 📌 Features
- **Automated Notice Syncing**: Automatically scrapes and synchronizes placement notices from the college portal.
- **AI-Powered Extraction**: Uses Google Gemini to intelligently parse unstructured notices and categorize them as either "New Drives" or "Follow-ups" (e.g., shortlists, interview schedules).
- **Attachment & Document Handling**: Automatically detects, downloads, and forwards documents (PDFs, PPTs) directly through WhatsApp.
- **Table-to-CSV Conversion**: Parses complex HTML tables (like candidate shortlists) from the notice body and automatically converts them into downloadable CSV files for easy sharing.
- **Reliable Broadcasting**: Uses a Redis-backed message queue (BullMQ) to reliably dispatch WhatsApp notifications without hitting rate limits.

## 🛠️ Tech Stack Used
- **Core Environment**: Node.js
- **Scraping & Parsing**: Playwright, Cheerio
- **WhatsApp Integration**: `whatsapp-web.js`
- **AI Integration**: Google GenAI API (Gemini)
- **Database**: MongoDB (Mongoose) for non-persistent storage and state tracking
- **Message Queue / Caching**: Redis, BullMQ (with BullMQ Express Dashboard)
- **File Storage**: AWS S3 (`@aws-sdk/client-s3`)
- **Infrastructure**: Docker, AWS EC2 (Linux)

## 🚧 Problems Faced & Solutions
1. **EC2 Memory Constraints & Puppeteer Timeouts**
   - *Problem*: The headless browser would frequently hang or timeout due to low memory on the EC2 instance, stalling the bot.
   - *Solution*: Configured SWAP memory on the instance and optimized the headless browser launch arguments to reduce memory footprint.
2. **WhatsApp Web Initialization Stalls**
   - *Problem*: The bot would randomly hang during the WhatsApp Web QR code authentication phase due to rapid WhatsApp web updates.
   - *Solution*: Pinned the application to a stable `webVersionCache` to ensure consistent and reliable startup.
3. **Duplicate Notifications for Follow-Up Posts**
   - *Problem*: The bot originally treated follow-up announcements (like interview dates for an existing company) as entirely new drives, causing confusing duplicate alerts.
   - *Solution*: Improved the Gemini AI extraction prompt to accurately classify a notice as `isFollowUp`, allowing the bot to thread updates cleanly.
4. **AI API Rate Limiting (503 Service Unavailable)**
   - *Problem*: Occasional failures during AI extraction when the Gemini API was overloaded.
   - *Solution*: Implemented robust error handling with exponential backoff and retry logic within the BullMQ worker tasks.

## 🚀 Future Goals
- **RAG Model Integration**: Upgrade the bot from a one-way notification system to an interactive assistant where students can query past placement trends and ask questions using Retrieval-Augmented Generation.
- **Automated Resume Analysis**: Allow students to upload their resumes to be automatically matched against company job descriptions (JDs).
- **Official API Migration**: Transition from `whatsapp-web.js` to the official WhatsApp Business Cloud API for enhanced stability and interactive UI elements (buttons, lists).
