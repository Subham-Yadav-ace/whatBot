const { downloadStorageState, extractSessionCookie } = require('./src/portal/sessionManager');
const { getFreshJWT, fetchPostList, fetchAttachments } = require('./src/portal/portalClient');

async function run() {
  await downloadStorageState();
  const cookie = extractSessionCookie();
  const jwt = await getFreshJWT(cookie);
  const posts = await fetchPostList(jwt);
  
  for (const post of posts) {
    const atts = await fetchAttachments(jwt, post.id);
    if (atts && atts.length > 0) {
      console.log('Attachments for post', post.id, ':');
      console.log(JSON.stringify(atts, null, 2));
      break;
    }
  }
  process.exit(0);
}
run();
