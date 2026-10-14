/** 插件版本与标识（单一真相源 —— 避免多处硬编码漂移） */

export const PLUGIN_ID = "serenity-acc"

/** 适配层版本（与 package.json 的 version 手工同步；发布时校验） */
export const ACC_VERSION = "0.1.2"

/** ACC 标准版本（specs 的版本，用于 ACC 身份块展示） */
export const SPECS_VERSION = "2.0.0"
