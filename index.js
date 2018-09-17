const { promisify } = require("util");

const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const tar = require("tar");
const through2 = require("through2");
const amqp = require("amqplib");
const execa = require("execa");

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const DOCKER_CREDENTIALS_PATH='/gcr/mechmania2017-key.json'
const COMPILER_QUEUE = `compilerQueue`;
const STANCHION_QUEUE = `stanchionQueue`;
const COMPILE_DIR = "/compile";

const s3 = new AWS.S3({
  params: { Bucket: "mechmania" }
});

const getObject = promisify(s3.getObject.bind(s3));
const upload = promisify(s3.upload.bind(s3));
const mkdir = promisify(fs.mkdir);
const chmod = promisify(fs.chmod);
const readdir = promisify(fs.readdir);

async function main() {
  // Login to docker
  // docker login -u _json_key --password-stdin https://gcr.io
  const dockerLoginProc = execa("docker", ["login", "-u", "_json_key", "--password-stdin", "https://gcr.io"])
  fs.createReadStream(DOCKER_CREDENTIALS_PATH).pipe(dockerLoginProc.stdin);
  const { stdout, stderr } = await dockerLoginProc;
  console.log(stdout, stderr)

  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(COMPILER_QUEUE, { durable: true });
  ch.assertQueue(STANCHION_QUEUE, { durable: true });
  process.on("SIGTERM", async () => {
    console.log("Got SIGTERM");
    await ch.close();
    conn.close();
  });

  console.log(`Listening to ${COMPILER_QUEUE}`);
  ch.consume(
    COMPILER_QUEUE,
    async message => {
      console.log(`Got message`);
      const id = message.content.toString();

      // Extract and decompress
      console.log(`${id} - Extracting contents of script to ${COMPILE_DIR}`);

      await mkdir(COMPILE_DIR);
      const data = s3
        .getObject({ Key: `scripts/${id}` })
        .createReadStream()
        .pipe(tar.x({ C: COMPILE_DIR }));

      data.on("close", async () => {
        const image = `gcr.io/mechmania2017/${id}`;
        // Compile the script
        console.log(`${id} - Compiling files at ${COMPILE_DIR}`);
        // TODO: Handle errors
        const { stdout, stderr } = await execa("docker", [
          "build",
          COMPILE_DIR,
          "-t",
          image
        ]);
        console.log(stdout);
        console.warn(stderr);

        // Push to GCR
        const { stdout: pushStdOut, stderr: pushStdErr } = await execa(
          "docker",
          ["push", image]
        );
        console.log(pushStdOut);
        console.warn(pushStdErr);

        // Notify Stanchion
        console.log(`${id} - Notifying ${STANCHION_QUEUE}`);
        ch.sendToQueue(STANCHION_QUEUE, Buffer.from(id), { persistent: true });

        // clear the COMPILE_DIR
        console.log(`${id} - Cleaning ${COMPILE_DIR}`);
        await rimraf(COMPILE_DIR);

        ch.ack(message);
      });
    },
    { noAck: false }
  );
}
main().catch(console.trace);
