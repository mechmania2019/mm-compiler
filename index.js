const { promisify } = require("util");

const mongoose = require("mongoose");
const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const tar = require("tar");
const amqp = require("amqplib");
const execa = require("execa");
const { Script } = require("mm-schemas")(mongoose);

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const DOCKER_CREDENTIALS_PATH = "/gcr/mechmania2017-key.json";
const COMPILER_QUEUE = `compilerQueue`;
const STANCHION_QUEUE = `stanchionQueue`;
const COMPILE_DIR = "/compile";
const KUBECTL_PATH = path.join(__dirname, "kubectl"); // ./
const BOT_PORT = 8080;

mongoose.connect(process.env.MONGO_URL);
mongoose.Promise = global.Promise;

const s3 = new AWS.S3({
  params: { Bucket: "mechmania2019" }
});

const upload = promisify(s3.upload.bind(s3));
const mkdir = promisify(fs.mkdir);

async function main() {
  // Login to docker
  // docker login -u _json_key --password-stdin https://gcr.io
  const dockerLoginProc = execa("docker", [
    "login",
    "-u",
    "_json_key",
    "--password-stdin",
    "https://gcr.io"
  ]);
  fs.createReadStream(DOCKER_CREDENTIALS_PATH).pipe(dockerLoginProc.stdin);
  const { stdout, stderr } = await dockerLoginProc;
  console.log(stdout, stderr);

  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(COMPILER_QUEUE, { durable: true });
  ch.assertQueue(STANCHION_QUEUE, { durable: true });
  ch.prefetch(1);
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

      console.log(`Finding script ${id} in mongo`);
      console.log(1);
      const script = await Script.findOne({ key: id })
        .populate("owner")
        .exec();
      console.log(2);
      // clear the COMPILE_DIR
      console.log(`${id} - Cleaning ${COMPILE_DIR}`);
      await rimraf(COMPILE_DIR);

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
        let stdout = "";
        let stderr = "";
        let success = false;
        try {
          const proc = await execa("docker", [
            "build",
            COMPILE_DIR,
            "-t",
            image
          ]);
          stdout = proc.stdout;
          stderr = proc.stderr;
          success = true;
        } catch (e) {
          stdout = e.stdout;
          success = false;
          stderr = e.stderr;
        }
        console.log(stdout);
        console.warn(stderr);
        const body = `
        ==================================================
          
        stdout:
        ${stdout}
          
        =================================================== 
          
        stderr:
        ${stderr}
        `;

        console.log(`${id} - Upload logs to s3 (${id})`);
        const data = await upload({
          Key: `compiled/${id}`,
          Body: body
        });
        console.log(`${id} - Uploaded logs to s3 (${data.Location})`);

        if (success) {
          // Push to GCR
          console.log(`${id} - Pushing image to GCR`);
          const { stdout: pushStdOut, stderr: pushStdErr } = await execa(
            "docker",
            ["push", image]
          );
          console.log(pushStdOut);
          console.warn(pushStdErr);
          console.log(`${id} - Successfully pushed image to gcr`);

          console.log(`${id} - Spinning up new Kubernetes deployment...`);
          const yamlSpec = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bot-${id}
  labels:
    app: bot
    bot: "${id}"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bot
      bot: "${id}"
  template:
    metadata:
      labels:
        app: bot
        bot: "${id}"
    spec:
      containers:
      - name: bot
        image: ${image}
        ports:
        - containerPort: ${BOT_PORT}
        env:
          - name: PORT
            value: "${BOT_PORT}"
---
apiVersion: v1
kind: Service
metadata:
  name: bot-service-${id}
  labels:
    app: bot
    bot: "${id}"
spec:
  selector:
    bot: "${id}"
  ports:
  - port: 80
    targetPort: ${BOT_PORT}
    protocol: TCP
`;
          const proc = execa(KUBECTL_PATH, ["apply", "-f", "-"]);
          proc.stdin.write(yamlSpec);
          proc.stdin.end();
          const { stdout: kubectlOut, stderr: kubectlErr } = await proc;
          console.log(kubectlOut);
          console.warn(kubectlErr);
          console.log(`Successfully started kubernetes deployment ${image}`);

          console.log("Getting IP address");
          const { stdout: ip } = await execa(KUBECTL_PATH, [
            "get",
            "service",
            `bot-service-${id}`,
            "-o=jsonpath='{.spec.clusterIP}'"
          ]);
          console.log(`${id} - Got IP ${ip}. Saving to Mongo`);
          script.ip = ip.slice(1, -1); // remove the single quotes
          await script.save();
          console.log(`${id} - Saved IP to Mongo`);

          // This bot is finally ready for others to start playing against
          const team = script.owner;
          team.latestScript = script.id;
          await team.save();
          console.log(
            `${team.name} - Updated team latestScript (${team.latestScript})`
          );

          // Notify Stanchion
          console.log(`${id} - Notifying ${STANCHION_QUEUE}`);
          ch.sendToQueue(STANCHION_QUEUE, Buffer.from(id), {
            persistent: true
          });
        }

        ch.ack(message);
      });
    },
    { noAck: false }
  );
}
main().catch(console.trace);
