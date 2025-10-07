<template>
  <a-layout>
    <a-layout-header class="header">
      <div class="logo" />
      <a-menu v-model:selectedKeys="selectedKeys1" theme="dark" mode="horizontal" :style="{ lineHeight: '64px' }">
        <a-menu-item key="1">nav 1</a-menu-item>
        <a-menu-item key="2">nav 2</a-menu-item>
        <a-menu-item key="3">nav 3</a-menu-item>
      </a-menu>
    </a-layout-header>
    <a-layout-content style="padding: 0 50px">
      <a-breadcrumb style="margin: 16px 0">
        <a-breadcrumb-item>Home</a-breadcrumb-item>
        <a-breadcrumb-item>List</a-breadcrumb-item>
        <a-breadcrumb-item>App</a-breadcrumb-item>
      </a-breadcrumb>
      <a-layout style="padding: 24px 0; background: #fff">
        <a-layout-sider width="200" style="background: #fff">
          <a-menu v-model:selectedKeys="selectedKeys2" v-model:openKeys="openKeys" mode="inline" style="height: 100%">
            <a-sub-menu key="sub1">
              <template #title>
                <span>
                  <user-outlined />
                  subnav 1
                </span>
              </template>
              <a-menu-item key="1">option1</a-menu-item>
              <a-menu-item key="2">option2</a-menu-item>
              <a-menu-item key="3">option3</a-menu-item>
              <a-menu-item key="4">option4</a-menu-item>
            </a-sub-menu>
            <a-sub-menu key="sub2">
              <template #title>
                <span>
                  <laptop-outlined />
                  subnav 2
                </span>
              </template>
              <a-menu-item key="5">option5</a-menu-item>
              <a-menu-item key="6">option6</a-menu-item>
              <a-menu-item key="7">option7</a-menu-item>
              <a-menu-item key="8">option8</a-menu-item>
            </a-sub-menu>
            <a-sub-menu key="sub3">
              <template #title>
                <span>
                  <notification-outlined />
                  subnav 3
                </span>
              </template>
              <a-menu-item key="9">option9</a-menu-item>
              <a-menu-item key="10">option10</a-menu-item>
              <a-menu-item key="11">option11</a-menu-item>
              <a-menu-item key="12">option12</a-menu-item>
            </a-sub-menu>
          </a-menu>
        </a-layout-sider>
        <a-layout-content :style="{ padding: '0 24px', minHeight: '280px' }">
          <div style="background-color: #ececec; padding: 20px">
            <a-row :gutter="16">
              <a-col :span="8">
                <a-card title="base" :bordered="false">
                  <div v-if="userInfo">
                    <a-avatar :size="64" :src="userInfo.avatar"> </a-avatar>
                    <a-typography-title :level="4">{{ userInfo.name }}</a-typography-title>
                    <a-tag v-for="(tag, index) in userInfo.tags" :key="index" :color="tag.color">{{ tag.content
                    }}</a-tag>
                    <p>
                      <a-typography-text type="secondary">rank: {{ userInfo.rank }}</a-typography-text>
                      <br />
                      <a-typography-text type="secondary">last login time: {{ userInfo.LastLoginTime
                      }}</a-typography-text>
                      <br />
                      <a-typography-text type="secondary">personalSignature: {{ userInfo.personalSignature
                      }}</a-typography-text>
                    </p>
                  </div>
                  <div v-else>please get login sessage</div>
                  <a-button type="primary" @click="baseAction">get login message</a-button>
                </a-card>
              </a-col>
              <a-col :span="8">
                <a-card title="Card title" :bordered="false">
                  <p>{{ testVar }}</p>
                  <a-button type="primary" @click="testAction">Primary Button</a-button>
                </a-card>
              </a-col>
              <a-col :span="8">
                <a-card title="Card title" :bordered="false">
                  <p>card content</p>
                  <a-button type="primary">Primary Button</a-button>
                </a-card>
              </a-col>
            </a-row>
          </div>
        </a-layout-content>
      </a-layout>
    </a-layout-content>
    <a-layout-footer style="text-align: center"> MOCKING BIRD </a-layout-footer>
  </a-layout>
</template>

<script setup>
import { ref } from 'vue';
import axios from 'axios';

const userInfo = ref();
const testVar = ref('card content');

const baseAction = async () => {
  let userData;
  await axios({
    method: 'get',
    url: 'http://127.0.0.1:5000/test/getUserInfo',
    params: {
      userID: '0001',
    },
  }).then((response) => {
    userData = response.data;
  });
  if (userData.authority.includes('super_admin')) {
    userData.name = userData.name + '(super_admin)';
  } else if (userData.authority.includes('admin')) {
    userData.name = userData.name + '(admin)';
  }

  userData['rank'] = Math.floor(userData['experience'] / 150);
  userData['LastLoginTime'] = timestampToDate(userData.LastLoginTime);
  userData['RegisterTime'] = timestampToDate(userData.LastLoginTime);
  userInfo.value = userData;
};

const testAction = async () => {
  await axios({
    method: 'get',
    url: 'http://127.0.0.1:5000/test/getSingleInfo',
  }).then((response) => {
    testVar.value = response.data.testVar;
  });
};

const timestampToDate = (timestamp) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};
</script>