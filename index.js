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
const COMPILER_QUEUE = `compilerQueue`;
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
  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(COMPILER_QUEUE, { durable: true });

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
        .getObject({ Key: id })
        .createReadStream()
        .pipe(tar.x({ C: COMPILE_DIR }));

      data.on("close", async () => {
        // Compile the script
        console.log(`${id} - Compiling files at ${COMPILE_DIR}`);
        // TODO: Handle errors
        await execa("python", ["compiler.py", COMPILE_DIR]);
        await chmod(path.join(COMPILE_DIR, "run.sh"), 755);
        console.log(await readdir(COMPILE_DIR));

        // Compress and save the files to s3
        console.log(`${id} - Uploading files to s3`);
        const data = await upload({
          Key: id.replace(/scripts/, "compiled"),
          Body: tar.c({ gzip: true, cwd: COMPILE_DIR }, ["."]).pipe(through2())
        });
        console.log(`${id} - Uploaded to s3 (${data.Location})`);

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
