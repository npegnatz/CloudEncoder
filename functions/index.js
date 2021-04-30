const admin = require('firebase-admin');
const functions = require('firebase-functions');
const {Storage} = require('@google-cloud/storage');
const {CloudTasksClient} = require('@google-cloud/tasks');
const serviceAccount = require('./service-account.json');
const path = require('path');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://clips-ecd84.firebaseio.com"
});

const firestore = admin.firestore();

//Detect Video Upload
exports.startEncoding = functions.storage.bucket('clips-ecd84.appspot.com').object().onFinalize(async (object) => {
  const filePath = object.name;
  const contentType = object.contentType; 
  const filename = path.basename(filePath);

  //Check that media is video
  if(!contentType.startsWith('video/') || filename.includes('.png') || filename.includes('.jpg')) { 
    return; 
  }

  //Create Cloud Task
  const client = new CloudTasksClient();
  const project = 'clips-ecd84';
  const queue = 'encode-queue';
  const location = 'us-central1';

  const url = 'https://encoding-lkljmvtnbq-uc.a.run.app/encode-video';
  const inSeconds = 0;
  const data = {
    path: filePath,
    key: "rybpo6si2q19y2f"
  };

  const parent = client.queuePath(project, location, queue);
  const task = {
    httpRequest: {
      httpMethod: 'POST',
      headers: {
        "Content-Type": "application/json"
      },
      url,
    },
  };
  task.httpRequest.body = Buffer.from(JSON.stringify(data)).toString('base64');
  task.scheduleTime = {
    seconds: inSeconds + Date.now() / 1000,
  };

  //Queue Task
  const request = {parent, task};
  const [response] = await client.createTask(request);
  console.log('Queued Encode Task: ', filePath);
  return;
});


//Setup playback video location in database after encoding
exports.setupPlayback = functions.https.onRequest((req, res) => {
  res.sendStatus(200);
  const videoId = req.body.id;
  const baseUrl = `https://storage.googleapis.com/video-playback/${videoId}`;
  const thumbnailUrl = baseUrl + `/thumbnail.png`;
  const streamUrl = baseUrl + `/stream/main.m3u8`;
  firestore.collection('posts').doc(videoId).set({
    playback: {
      stream: streamUrl,
      thumbnail: thumbnailUrl
    }
  }, {merge: true});
  return;
});
