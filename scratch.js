const mongoose = require('mongoose');
const Notice = require('./src/models/Notice');
const env = require('./src/config/env');

async function run() {
  await mongoose.connect(env.mongoUri);
  const notice = await Notice.findOne({ 'attachments.0': { $exists: true } }).lean();
  console.log(JSON.stringify(notice?.attachments, null, 2));
  process.exit(0);
}
run();
