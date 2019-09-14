# Method 1: done through curl
# FROM alpine 
# RUN apk add --update -t deps curl \ 
#     && curl -LO https://storage.googleapis.com/kubernetes-release/release/%60curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt%60/bin/linux/amd64/kubectl

FROM mhart/alpine-node:10 as base
WORKDIR /usr/src
COPY package.json yarn.lock /usr/src/
RUN yarn --production
COPY . .

FROM mhart/alpine-node:base-10
RUN apk add --update --no-cache docker
WORKDIR /usr/src
ENV NODE_ENV="production"
COPY --from=base /usr/src .

# Method 2: curtosy of https://www.jeffgeerling.com/blog/2018/install-kubectl-your-docker-image-easy-way
# Install kubectl from Docker Hub.
# COPY --from=lachlanevenson/k8s-kubectl:v1.10.3 /usr/local/bin/kubectl /usr/local/bin/kubectl

CMD ["node", "index.js"]