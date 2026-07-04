/**
 * Connector factory.
 */
import type { DatabaseConfig } from '../config/types.js';
import { BaseConnector } from './base-connector.js';
import { PostgresConnector } from './postgres-connector.js';
import { MssqlConnector } from './mssql-connector.js';
import { OracleConnector } from './oracle-connector.js';
import { HanaBwConnector } from './hanabw-connector.js';
import { AccessConnector } from './access-connector.js';

export function createConnector(config: DatabaseConfig): BaseConnector {
  if (config.dbType === 'access') {
    return new AccessConnector(config);
  }
  if (config.dbType === 'mssql') {
    return new MssqlConnector(config);
  }
  if (config.dbType === 'oracle') {
    return new OracleConnector(config);
  }
  if (config.dbType === 'hanabw') {
    return new HanaBwConnector(config);
  }
  return new PostgresConnector(config);
}
