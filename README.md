# Strata Vote

A production-ready full-stack web application for strata council voting via one-time links. Built with Node.js, Express, SQLite, and EJS templates.

## Features

- **Admin Management**: Password-protected admin area for property management
- **Motion Creation**: Create voting motions with custom options and time windows
- **One-Time Voting Links**: Generate secure, single-use voting tokens for council members
- **Real-Time Results**: Track vote counts, turnout, and results
- **Export Functionality**: Export ballot data as CSV
- **Mobile-Friendly**: Responsive design optimized for mobile voters
- **Secure**: Server-side validation, session management, optional IP hashing

## Technology Stack

- **Backend**: Node.js + Express
- **Database**: SQLite (file-based)
- **Templates**: EJS (server-rendered)
- **Session**: express-session
- **Security**: Environment variables for sensitive data

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Create environment variables:
```bash
cp .env.example .env
```

4. Edit `.env` and set your values:
```env
ADMIN_PASSWORD=your_secure_password
SESSION_SECRET=your_random_secret_string
BASE_URL=http://localhost:3300
PORT=3300
```

## Running the Application

Start the server:
```bash
npm start
```

The application will be available at `http://localhost:3300`

## Usage Guide

### 1. Admin Login

Navigate to `http://localhost:3300/admin/login` and enter your admin password.

### 2. Create a Motion

1. Click "New Motion" on the dashboard
2. Fill in the motion details:
   - **Title**: Brief description (e.g., "Approve 2024 Budget")
   - **Description**: Full details about the motion
   - **Options**: Comma-separated voting choices (default: Yes, No, Abstain)
   - **Voting Period**: Start and end date/time
   - **Required Majority**: Simple (>50%) or Two-Thirds (≥66.67%)
3. Click "Create Motion"

The motion will be created with status "Draft"

### 3. Generate Voter Tokens

1. Go to the motion detail page
2. Click "Manage Voter Tokens"
3. Enter recipients in the textarea, one per line:
   ```
   John Doe,john@example.com,Unit 101
   Jane Smith,jane@example.com,Unit 102
   Bob Wilson,bob@example.com
   ```
   Format: `Name,Email,Unit` (unit is optional)
4. Click "Generate Tokens"
5. Copy the generated voting links and send them to voters via email

### 4. Open Voting

1. Go to the motion detail page
2. Change status from "Draft" to "Open"
3. Voters can now use their links to vote

### 5. Monitor Results

- View real-time vote counts on the dashboard
- See detailed results breakdown on the motion detail page
- Track turnout percentage and remaining votes

### 6. Close Voting and Set Outcome

1. Change motion status to "Closed" when voting period ends
2. Review the results
3. Set the outcome (Passed/Failed/Tie/Cancelled) with optional notes
4. Change status to "Published" to finalize

### 7. Export Data

Click "Export Ballots (CSV)" on the motion detail page to download vote data including timestamps, choices, and voter information.

## Database Schema

### motions
Stores voting motions with configuration and status.

### voter_tokens
Stores one-time voting links with recipient information.

### ballots
Stores submitted votes with timestamps and optional IP hashing.

## Security Features

- Admin area protected by password authentication
- Session-based authentication with HTTP-only cookies
- Server-side validation of all vote submissions
- One-time token usage enforcement (database constraint)
- Optional IP address hashing for audit trail
- Prepared statements to prevent SQL injection
- Transaction safety for critical operations

## Environment Variables

### Required

- `ADMIN_PASSWORD`: Password for admin login
- `SESSION_SECRET`: Secret key for session encryption

### Optional

- `BASE_URL`: Base URL for generating voting links (default: http://localhost:3300)
- `PORT`: Server port (default: 3000)
- `IP_HASH_SALT`: Salt for IP address hashing (if not set, IPs are not stored)

## Smoke Test

After installation, test the complete flow:

1. Login to admin area
2. Create a motion that opens now and closes in 24 hours
3. Generate 2 voting tokens
4. Open the motion
5. Use the first voting link to cast a vote (should succeed)
6. Try to use the same link again (should show "already used")
7. Check the dashboard to verify vote count is correct
8. Export the ballot data

## Production Deployment

### Security Features

This application includes comprehensive security protections:

- **CSRF Protection**: All forms protected against cross-site request forgery
- **Rate Limiting**: Login attempts limited to 5 per 15 minutes, vote submissions to 10 per minute
- **Session Security**: Secure cookies with httpOnly, sameSite=strict, and secure flags in production
- **Security Headers**: Helmet.js provides CSP, HSTS, X-Frame-Options, and other protections
- **Input Validation**: Joi validates all user inputs with strict schemas
- **HTTPS Enforcement**: Automatic redirect to HTTPS in production mode
- **Database Safety**: WAL mode enabled, proper indexes, transaction error handling
- **Structured Logging**: Winston logs all events to files with rotation
- **Graceful Shutdown**: Proper cleanup of database connections on SIGTERM/SIGINT

### Pre-Deployment Checklist

1. **Generate Strong Secrets**:
   ```bash
   # Generate SESSION_SECRET (32+ characters)
   openssl rand -base64 32

   # Generate strong ADMIN_PASSWORD (20+ characters recommended)
   # Use a password manager or secure random string
   ```

2. **Configure Environment Variables**:
   Create a production `.env` file:
   ```env
   NODE_ENV=production
   ADMIN_PASSWORD=<your-strong-password-min-20-chars>
   SESSION_SECRET=<output-from-openssl-command>
   BASE_URL=https://vote.yourdomain.com
   PORT=3300
   LOG_LEVEL=info
   IP_HASH_SALT=<random-hex-string-for-ip-hashing>
   ```

3. **Install Dependencies**:
   ```bash
   npm install --production
   ```

4. **Set File Permissions**:
   ```bash
   chmod 600 .env
   chmod 600 data.sqlite  # After first run
   mkdir -p logs backups
   chmod 755 logs backups
   ```

5. **Configure HTTPS** (Required for production):
   - Set up SSL certificate (Let's Encrypt recommended)
   - Configure reverse proxy (nginx or Apache)
   - Application will automatically redirect HTTP to HTTPS

### Recommended nginx Configuration

```nginx
server {
    listen 80;
    server_name vote.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name vote.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/vote.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vote.yourdomain.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://localhost:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Process Management with systemd

Create `/etc/systemd/system/strata-vote.service`:

```ini
[Unit]
Description=Strata Vote Application
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/strata-vote
Environment=NODE_ENV=production
EnvironmentFile=/opt/strata-vote/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/opt/strata-vote/logs/systemd.log
StandardError=append:/opt/strata-vote/logs/systemd-error.log

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable strata-vote
sudo systemctl start strata-vote
sudo systemctl status strata-vote
```

### Database Backups

The application includes a backup script at `scripts/backup.sh`. Set up automated backups:

```bash
# Make script executable
chmod +x scripts/backup.sh

# Test backup manually
./scripts/backup.sh

# Add to crontab for daily backups at 2 AM
crontab -e
# Add this line:
0 2 * * * cd /opt/strata-vote && ./scripts/backup.sh >> logs/backup.log 2>&1
```

Backups are stored in the `backups/` directory and automatically cleaned up after 7 days.

### Monitoring and Logs

The application logs to:
- `logs/combined.log` - All logs (info, warn, error)
- `logs/error.log` - Error logs only

Monitor logs:
```bash
# Watch all logs
tail -f logs/combined.log

# Watch errors only
tail -f logs/error.log

# Check systemd logs
sudo journalctl -u strata-vote -f
```

### Security Best Practices

1. **Keep Dependencies Updated**: Run `npm audit` regularly and update dependencies
2. **Monitor Failed Login Attempts**: Check logs for suspicious activity
3. **Secure Database Exports**: CSV exports contain PII - handle securely
4. **Regular Backups**: Test backup restoration periodically
5. **Firewall Configuration**: Only expose ports 80 and 443
6. **Rate Limiting**: Monitor for DoS attempts in logs
7. **Session Management**: Sessions expire after 24 hours automatically

## File Structure

```
strata-vote/
├── server.js           # Express application
├── db.js              # Database initialization and queries
├── package.json       # Dependencies
├── .env               # Environment variables (not in git)
├── .env.example       # Environment template
├── README.md          # This file
├── data.sqlite        # SQLite database (created on first run)
├── views/             # EJS templates
│   ├── vote.ejs
│   ├── vote_result.ejs
│   ├── admin_login.ejs
│   ├── admin_dashboard.ejs
│   ├── motion_new.ejs
│   ├── motion_detail.ejs
│   ├── tokens.ejs
│   └── partials/
│       └── admin_header.ejs
└── public/            # Static assets
    └── styles.css
```

## Troubleshooting

**"ADMIN_PASSWORD environment variable is required"**
- Create a `.env` file with `ADMIN_PASSWORD=your_password`

**"Invalid voting link"**
- Check that the motion status is "Open"
- Verify the voting period (between open_at and close_at)
- Ensure the token hasn't been used or revoked

**Cannot connect to database**
- Ensure the application has write permissions in its directory
- Check that no other process is locking `data.sqlite`

## License

MIT

## Support

For issues or questions, refer to the code comments or contact your system administrator.
