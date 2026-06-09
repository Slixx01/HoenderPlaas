Deployment (Render.com)

1. Push your repository to GitHub.

2. Sign up at https://render.com (free tier available).

3. Create a new Web Service and connect your GitHub repo.
   - Choose 'Python' and the branch to deploy.
   - For the start command, Render detects `Procfile`. If needed, set:
     `gunicorn app:app`

4. Set environment variables (optional):
   - `FLASK_DEBUG=0`

5. Deploy. Render will install from `requirements.txt` and run `gunicorn app:app`.

Notes:
- This app stores uploaded files in a local `uploads/` folder. On ephemeral cloud instances this folder is not persistent — the app already only uses uploaded files for processing and does not store data long-term.
- If you prefer Vercel, you'd need to convert the backend to serverless functions; Render is simpler for Flask apps.
