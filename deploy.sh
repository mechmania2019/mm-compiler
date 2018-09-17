#!/bin/bash

docker build . -t gcr.io/mechmania2017/compiler:latest
docker push gcr.io/mechmania2017/compiler:latest
kubectl apply -f app.yaml
kubectl delete pods -l app=compiler