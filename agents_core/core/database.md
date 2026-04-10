# Core Database Standards

## Inherited Standards
@./global.md

## 🗄️ Universal Data Principles
1. **Data Integrity:** Ensure data is accurate, complete, and consistent across its lifecycle.
2. **Security:** Implement encryption at rest and in transit. Use least privilege for DB users.
3. **Performance Monitoring:** Always monitor query execution times and resource usage (CPU/IO).
4. **Backup & Recovery:** Ensure automated backups and test the restoration process regularly.
5. **Secrets:** NEVER hardcode credentials; use a secure vault or environment variables.
