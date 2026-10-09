# Optional forecasting service (docker compose --profile forecast up). The API uses its built-in forecasts without it.
FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py models.py ./
ENV PORT=8000
EXPOSE 8000
USER nobody
CMD ["python", "main.py"]
