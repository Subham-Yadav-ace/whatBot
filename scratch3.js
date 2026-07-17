const axios = require('axios');
async function run() {
  try {
    const res = await axios.head('https://aitplacements-in-2026.s3.ap-south-1.amazonaws.com/jd-daa-2026.pdf');
    console.log('Public bucket HEAD success:', res.status);
  } catch (err) {
    console.log('HEAD error:', err.response?.status || err.message);
  }
}
run();
