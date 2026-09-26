<script setup lang="ts">
import { useI18n } from 'vue-i18n'

// 提示只显示文案，不把异步组件转交的图表属性透传到段落元素。
defineOptions({ inheritAttrs: false })

const { t } = useI18n()
</script>

<template>
  <p class="muted" role="status">
    {{ t('trafficSankey.chartLoading') }}
  </p>
</template>
