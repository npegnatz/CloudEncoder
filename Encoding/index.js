const admin = require("firebase-admin");
const {Storage} = require('@google-cloud/storage');
const adminService = require("./admin-key.json");
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const axios = require('axios');
const express = require('express');
const process = require("process");
const parser = require('body-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');
admin.initializeApp({
    credential: admin.credential.cert(adminService),
    storageBucket: "clips-ecd84.appspot.com"
});

ffmpeg.setFfmpegPath(ffmpegPath);

const firebaseBucket = admin.storage().bucket();
const playbackBucket = admin.storage().bucket('video-playback');

const app = express();
app.use(parser.raw());
app.use(parser.json());
app.use(parser.text());
app.get('/', (req, res) => res.send('Bop'));
app.post('/encode-video', (req, res) => {
    const inputPath = req.body.path;
    const key = req.body.key;
    if(key != 'rybpo6si2q19y2f') {
        console.log('Invalid Authorization');
        console.log(req.body);
        res.sendStatus(401);
        return;
    }
    const tmpDir = os.tmpdir();
    const videoId = path.basename(inputPath, '.mp4');
    const thumbnailStream = playbackBucket.file(`${videoId}/thumbnail.png`).createWriteStream({resumable: false});

    const readStream = firebaseBucket.file(inputPath).createReadStream();
        ffmpeg(readStream).addOptions([  
        '-profile:v main',       
        '-c:v h264',
        '-c:a aac',
        '-ar 48000',
        '-b:a 192k',
        '-crf 5',
        '-preset fast',
        '-g 24',
        '-keyint_min 24',
        '-sc_threshold 0',                                                 
        '-b:v 3200k',                                     //(good = 2500k for all/hls_time = 3)   //'-force_key_frames expr:gte(t,n_forced*1)',
        '-maxrate 3200k',
        '-bufsize 1800k',
        '-hls_time 3',
        '-hls_playlist_type vod',
        `-hls_segment_filename ${tmpDir}/%03d.ts`,
        '-f hls',
        '-max_muxing_queue_size 1024'
        ]).on('end', () => {
            ffmpeg(`${tmpDir}/000.ts`).addOptions([
                '-ss 00:00:00',
                '-vframes 1',
                '-c:v png',
                '-f image2pipe'
            ]).on('end', () => {
                uploadToPlayback(videoId, res);
            }).on('error', (err, stdout, stderr) => {
                console.error('Thumbnail Error: ', err.message);
                console.error('stdout:', stdout);
                console.error('stderr:', stderr);
                res.sendStatus(400);
            }).writeToStream(thumbnailStream, { end: true });
        }).on('error', (err, stdout, stderr) => {
            console.error('Encoding Error: ', err.message);
            console.error('stdout:', stdout);
            console.error('stderr:', stderr);
            res.sendStatus(400);
        }).output(`${tmpDir}/main.m3u8`).run();
});


async function uploadToPlayback(videoId, res) {
    var fileList = [];
    let dirCtr = 1;
    let itemCtr = 0;
    const tmpDir = os.tmpdir();
    getFiles(tmpDir);

    function getFiles(dir) {
        fs.readdir(dir, (err, items) => {
            dirCtr--;
            itemCtr += items.length;
            items.forEach(item => {
                const fullPath = path.join(dir, item);
                fs.stat(fullPath, (err, stat) => {
                    itemCtr--;
                    if(stat.isFile()) {
                        const extension = path.extname(path.basename(fullPath));
                        if(extension == '.ts' || extension == '.m3u8') {
                            fileList.push(fullPath);
                        }
                    } else if(stat.isDirectory()) {
                        dirCtr++;
                        getFiles(fullPath);
                    }
                    if(dirCtr === 0 && itemCtr === 0) {
                        onComplete();
                    }
                });
            });
        });

        async function onComplete() {
            const resp = await Promise.all(
                fileList.map(filePath => {
                    const fileName = path.basename(filePath);
                    return playbackBucket.upload(filePath, { destination: `${videoId}/stream/${fileName}`}).then(() => {
                        fs.unlink(filePath, err => {
                            if(err) throw err;
                        });
                    }, (error) => {
                        console.log('Error uploading: ', error);
                        res.sendStatus(400);
                    });
                })
            ).then(() => {
                axios.post('https://us-central1-clips-ecd84.cloudfunctions.net/setupPlayback', {
                    id: videoId
                }).then(() => {
                    console.log('Finished');
                    res.sendStatus(200);
                }, (error) => {
                    console.log('Error requesting database update: ', error);
                    res.sendStatus(400);
                });
            }, (error) => {
                console.log('Failed to delete temporary files');
                res.sendStatus(200);
            });
        }
    }
}

app.listen(process.env.PORT || 8080);

//ffmpeg -i video.mp4 -filter_complex "[0:v] split [a][b];[a] palettegen [p];[b][p] paletteuse" converted-video.gif