# Core Backend Standards

## Inherited Standards
@./global.md

## ⚙️ Backend Principles
1. **Statelessness:** APIs must be stateless. Use JWT or similar for sessions if needed.
2. **API Standards:** Follow RESTful conventions (correct HTTP verbs and status codes).
3. **Database Integrity:**
    - Use Migrations for all schema changes (NEVER manual SQL in production).
    - Ensure proper indexing for performance.
    - Avoid N+1 query problems.
4. **Error Handling:** Implement a unified error response structure (e.g., `{"error": "message", "code": 400}`).
5. **Caching:** Use caching (Redis/Memcached) for expensive operations, but always handle cache invalidation.
