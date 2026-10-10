/** Keep transport limits aligned with saves' 2 MiB ciphertext quota. */
export function installJsonBodies(app: { use: (...args: any[]) => any }): void {
    const express = require('express');
    app.use('/api/auth/identity/saves', express.json({ limit: '3mb' }));
    app.use(express.json({ limit: '1mb' }));
}
