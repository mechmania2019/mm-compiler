const { promisify } = require('util')

const mongoose = require('mongoose')
const AWS = require('aws-sdk')
const uuid = require('node-uuid')
const authenticate = require('mm-authenticate')(mongoose)
// const { Team, Script } = require('mm-schemas')(mongoose)
const { send, buffer } = require('micro')
const fs = require('fs');
var fstream = require('fstream')

const amqp = require('amqplib');
const RABBITMQ_URI = process.env.RABBITMQ_URI ||'amqp://localhost';
const COMPILER_QUEUE = `compilerQueue`;
const unzip = require('unzip');
const execa = require('execa');

mongoose.connect(process.env.MONGO_URL)
mongoose.Promise = global.Promise

// const COMPILE_DIR = process.env.COMPILE_DIR;

// if(!COMPILE_DIR) {
//   throw new Error('An empty COMPILER_DIR should be created and path set in environment prior to running this')
// }


const s3 = new AWS.S3({
  params: { Bucket: 'mechmania' }
})

function getScripts(id) {
    return s3.getObject({Key: 'scripts/' + id}).createReadStream()
  }

async function unzipZips(scriptFileStreams) {
    return Promise.all(scriptFileStreams.map(({stream, id}) => {
      return new Promise((resolve, reject) => {
        const fPath = path.join(GAMES_DIR, id);
        const outStream = unzip.Extract({ path: fPath });
  
        outStream.on('close', () => resolve(fPath));
        outStream.on('error', reject);
        stream.on('error', reject);
  
        stream.pipe(outStream);
      })
    }))
  }

const getObject = promisify(s3.getObject.bind(s3))

async function main() {
    const conn = await amqp.connect(RABBITMQ_URI);
    const ch = await conn.createChannel();
    ch.assertQueue(COMPILER_QUEUE, {durable: true});

    ch.consume(COMPILER_QUEUE, async message => {
        const id = message.content.toString();
        // s3.getObject({Key: id}).createReadStream().pipe(unzip.Extract({ path: 'output' }));
        console.log(id)
        const data = s3.getObject({Key: id}).createReadStream().pipe(unzip.Extract({ path: 'output' }));
        console.log(data)
        ch.ack(message)
    }, {noAck: false})
}
main().catch(console.trace)