import mysql from 'mysql2/promise';

/**
 * MySQL 连接池配置
 * 通过环境变量配置，默认连接本地
 */
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'host.docker.internal',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'xander_lab',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

export default pool;
