import { createApp } from './app';
import { closeDatabase } from './db/database';
import logger from './utils/logger';

const PORT = process.env.PORT || 3000;

const app = createApp();

const server = app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down server...');
  server.close(() => {
    closeDatabase();
    logger.info('Server shut down gracefully');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;
