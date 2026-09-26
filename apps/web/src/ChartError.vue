<script setup lang="ts">
import { useI18n } from 'vue-i18n'

// 提示只显示文案，不把异步组件传入的错误对象透传到段落元素。
defineOptions({ inheritAttrs: false })

const { t } = useI18n()
</script>

<template>
  <p class="muted" role="alert">
    {{ t('trafficSankey.chartError') }}
  </p>
</template>
