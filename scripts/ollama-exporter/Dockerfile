FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir prometheus-client==0.20.0

COPY exporter.py /app/exporter.py

EXPOSE 9101

ENTRYPOINT ["python", "/app/exporter.py"]
