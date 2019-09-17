FROM wernight/kubectl as kubectl
FROM mhart/alpine-node:10 as base
WORKDIR /usr/src
COPY package.json yarn.lock /usr/src/
RUN yarn --production
COPY . .

FROM mhart/alpine-node:base-10
WORKDIR /usr/src

COPY --from=kubectl /usr/local/bin/kubectl /usr/src/kubectl
RUN apk add --update --no-cache docker curl ca-certificates
ENV NODE_ENV="production"
COPY --from=base /usr/src .
CMD ["node", "index.js"]