# Railway deployment

Create two Railway services from this repository:

1. API service: use `deploy/railway-api.toml`, set `PORT`, `CLIENT_ORIGIN`, `STORAGE_PROVIDER=postgres`, Supabase database variables, `AUTH_MODE=required`, model provider variables, and Memory Module variables.
2. Web service: use `deploy/railway-web.toml`, set `VITE_API_BASE_URL` to the API public HTTPS URL and the public `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` values, then rebuild.

Never put `DATABASE_URL`, model API keys, Memory Module service tokens, or `SUPABASE_JWT_SECRET` in web-service variables or frontend source. Configure custom domains and HTTPS in Railway after both health checks pass.
