// nodemailer 未自带类型声明；项目只用其 createTransport/sendMail 的最小面，
// 这里声明为 any，避免 checkJs 下的 TS7016（运行时行为不受影响）。
declare module 'nodemailer';
