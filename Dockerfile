FROM supercorp/supergateway:latest
ENV NODE_ENV=production
EXPOSE 8000
ENTRYPOINT ["sh", "-c"]
CMD ["supergateway --stdio \"npx -y @pinkpixel/mem0-mcp\" --outputTransport streamableHttp --stateful --sessionTimeout 3600000 --healthEndpoint /health --host 0.0.0.0 --port ${PORT:-8000}"]
