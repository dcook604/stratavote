const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'strata-vote' },
  transports: [
    // Write all logs to console
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    // Write error logs to file
    new winston.transports.File({
      filename: path.join(__dirname, 'logs/error.log'),
      level: 'error'
    }),
    // Write combined logs to file
    new winston.transports.File({
      filename: path.join(__dirname, 'logs/combined.log')
    })
  ]
});

module.exports = logger;
