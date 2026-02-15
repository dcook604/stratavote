# Contributing to Strata Vote

## Branching Strategy

We follow a feature branch workflow to keep the `main` branch stable and production-ready.

### Branch Structure

- **`main`** - Production-ready code, always deployable
- **`develop`** - Integration branch for features (optional)
- **`feature/*`** - Feature development branches
- **`bugfix/*`** - Bug fix branches
- **`hotfix/*`** - Emergency production fixes

### Workflow

#### 1. Starting a New Feature

```bash
# Always start from latest main
git checkout main
git pull origin main

# Create feature branch with descriptive name
git checkout -b feature/your-feature-name

# Examples:
# git checkout -b feature/sms-notifications
# git checkout -b feature/voting-analytics
# git checkout -b feature/multi-language-support
```

#### 2. During Development

```bash
# Make changes and commit regularly
git add .
git commit -m "Descriptive commit message"

# Push to remote regularly
git push origin feature/your-feature-name
```

#### 3. Creating a Pull Request

```bash
# Ensure your branch is up-to-date with main
git checkout main
git pull origin main
git checkout feature/your-feature-name
git merge main

# Resolve any conflicts if they exist
# Then push
git push origin feature/your-feature-name

# Create PR on GitHub:
# Go to: https://github.com/dcook604/stratavote/pulls
# Click "New Pull Request"
# Select: base: main <- compare: feature/your-feature-name
# Add description and create PR
```

#### 4. After PR is Merged

```bash
# Update local main
git checkout main
git pull origin main

# Delete local feature branch
git branch -d feature/your-feature-name

# Delete remote feature branch
git push origin --delete feature/your-feature-name
```

### Bug Fixes

```bash
# For non-urgent bugs
git checkout -b bugfix/fix-description main

# For urgent production issues
git checkout -b hotfix/critical-issue main
```

### Commit Message Guidelines

Use clear, descriptive commit messages:

```
# Good commits:
✅ Add email validation to token generation
✅ Fix voting link expiration bug
✅ Update README with email configuration
✅ Refactor database queries for performance

# Avoid:
❌ Fixed stuff
❌ WIP
❌ Changes
❌ Update
```

### Code Review Checklist

Before creating a PR, ensure:

- [ ] Code follows existing patterns and style
- [ ] No console.log() or debug statements left in code
- [ ] Environment variables documented in .env.example
- [ ] README.md updated if user-facing changes
- [ ] All files use consistent indentation
- [ ] No sensitive data (passwords, tokens) in code
- [ ] Error handling implemented
- [ ] Database migrations are safe (backwards compatible)

### Testing Before PR

```bash
# Check syntax
node -c server.js
node -c db.js
node -c email.js

# Test locally
npm start

# Run smoke tests if available
npm test
```

### Branch Protection (Recommended)

For team environments, configure on GitHub:
1. Go to Settings → Branches
2. Add rule for `main` branch:
   - ✅ Require pull request before merging
   - ✅ Require approvals (1 reviewer minimum)
   - ✅ Dismiss stale approvals when new commits are pushed
   - ✅ Require status checks to pass
   - ✅ Require branches to be up to date before merging
   - ✅ Include administrators

### Emergency Hotfix Process

For critical production issues:

```bash
# 1. Create hotfix from main
git checkout -b hotfix/critical-issue main

# 2. Fix the issue
# ... make changes ...

# 3. Test thoroughly
npm start  # Test locally

# 4. Commit and push
git commit -m "Hotfix: Description of critical fix"
git push origin hotfix/critical-issue

# 5. Create PR with "HOTFIX" label
# 6. Fast-track review and merge
# 7. Deploy immediately
```

## Development Best Practices

### Local Development

1. **Use separate environment files:**
   ```bash
   cp .env .env.local
   # Edit .env.local for local development
   # Never commit .env or .env.local
   ```

2. **Test email without SMTP:**
   - Leave SMTP variables empty
   - System will show links in UI instead

3. **Use SQLite browser for debugging:**
   ```bash
   sqlite3 data.sqlite
   # Or use DB Browser for SQLite GUI
   ```

### Database Changes

When modifying the database schema:

1. **Always use migrations** (in `db.js`)
2. **Make migrations backwards compatible**
3. **Test migration on a copy of production data**
4. **Never delete columns** (deprecate instead)

Example safe migration:
```javascript
// Good: Add new column with default
ALTER TABLE voter_tokens ADD COLUMN new_field TEXT DEFAULT '';

// Bad: Removing column breaks existing deployments
ALTER TABLE voter_tokens DROP COLUMN old_field;
```

### Security Guidelines

- Never commit `.env` files
- Never commit API keys or passwords
- Use environment variables for all secrets
- Review dependencies regularly: `npm audit`
- Keep dependencies updated: `npm update`
- Use strong passwords in production (20+ chars)
- Always use HTTPS in production

### Performance Considerations

- Database queries should use indexes
- Avoid N+1 queries
- Use transactions for multi-step operations
- Log slow operations for optimization
- Monitor memory usage in production

## Getting Help

- **Questions:** Open a GitHub Discussion
- **Bugs:** Open a GitHub Issue with reproduction steps
- **Security Issues:** Email maintainers privately (don't create public issues)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
